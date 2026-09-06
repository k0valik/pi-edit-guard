## Extension Architecture

Pi loads TypeScript extension modules via [jiti](https://github.com/unjs/jiti) (no compilation needed). The runtime:

1. Discovers extensions from `~/.pi/agent/extensions/` (global), `.pi/extensions/` (project-local), configured paths, and CLI `-e` flags.
2. Loads each module, calls its default-export factory with an `ExtensionAPI` instance.
3. Wires registered tools/commands/event handlers into the agent runtime.
4. Emits lifecycle events (`session_start`, `turn_start`, `tool_call`, …) through registered handlers.

The `ExtensionAPI` is the **only** pi-specific import extensions need. It provides:

| Method                                                                  | Purpose                                       |
| ----------------------------------------------------------------------- | --------------------------------------------- |
| `pi.on(event, handler)`                                                 | Subscribe to lifecycle events                 |
| `pi.registerTool(definition)`                                           | Register a tool callable by the LLM           |
| `pi.registerCommand(name, opts)`                                        | Register a slash-command                      |
| `pi.registerFlag(name, opts)`                                           | Register a CLI flag                           |
| `pi.registerShortcut(key, opts)`                                        | Register a keyboard shortcut                  |
| `pi.registerProvider(name, config)`                                     | Register a model provider                     |
| `pi.registerMessageRenderer(type, fn)`                                  | Custom TUI rendering for custom message types |
| `pi.sendMessage(msg, opts?)`                                            | Inject a custom message into the session      |
| `pi.sendUserMessage(content, opts?)`                                    | Send a user message to the agent              |
| `pi.appendEntry(type, data?)`                                           | Persist extension state in the session tree   |
| `pi.setLabel(id, label)`                                                | Set/clear a label on a session entry          |
| `pi.setSessionName(name)`                                               | Set session display name                      |
| `pi.getSessionName()`                                                   | Get current session name                      |
| `pi.exec(cmd, args, opts?)`                                             | Execute a shell command                       |
| `pi.getActiveTools()` / `pi.getAllTools()` / `pi.setActiveTools(names)` | Manage tool activation                        |
| `pi.setModel(model)`                                                    | Switch the active model                       |
| `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)`                  | Manage thinking level                         |
| `pi.events`                                                             | Shared event bus between extensions           |
| `pi.getFlag(name)`                                                      | Read a registered flag value                  |
| `pi.getCommands()`                                                      | Get available slash commands                  |

---

## Project Anatomy

```
extension.ts              ← Orchestration. Imports from src/*, wires to ExtensionAPI.
                           ← Default-export factory: (pi: ExtensionAPI) => void | Promise<void>.
src/
  core/example.ts         ← Pure functions. No pi API imports. Testable without pi runtime.
  tools/example.ts        ← defineTool() + registerTool(). TypeBox params, execute, onUpdate.
  commands/example.ts     ← registerCommand(name, { description, handler }). Session API.
  hooks/example.ts        ← pi.on("tool_call"), pi.on("agent_start"), etc. Event handlers.
  index.ts                ← Barrel re-exports for tests. Do NOT import extension.ts in tests.
```

Each module is **independent** — deleting one should not break another. The barrel export (`src/index.ts`) lets tests import registration functions without triggering the `extension.ts` side effects.

---

## Extension Patterns

### 1. Entry Point (`extension.ts`)

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMyTool } from "./src/tools/my-tool.js";
import { registerMyHook } from "./src/hooks/my-hook.js";
import { registerMyCommand } from "./src/commands/my-command.js";

export default (pi: ExtensionAPI) => {
  // Hooks first — ready before tools/commands fire
  registerMyHook(pi);

  // Then commands
  registerMyCommand(pi);

  // Then tools
  registerMyTool(pi);
};
```

- Factory can be `async` — pi awaits it before continuing startup.
- Do NOT start long-lived resources (processes, sockets, watchers) from the factory. Defer to `session_start` or the tool/command that needs them.
- Clean up in `session_shutdown`.

### 2. Tools

Tools are functions the LLM can call. They are defined with `defineTool()` and registered with `pi.registerTool()`.

```typescript
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";

const myTool = defineTool({
  name: "my_tool", // LLM sees this name
  label: "My Tool", // Human-readable for UI
  description: "What this tool does", // Shown to LLM in system prompt
  promptSnippet: "my_tool(action, text?)", // One-liner for Available Tools section
  promptGuidelines: [
    // Extra guidelines appended when tool is active
    "Use my_tool when the user asks for a task list instead of editing files.",
  ],
  parameters: Type.Object({
    action: Type.String({ description: "Action to perform" }),
    text: Type.Optional(Type.String({ description: "Optional text" })),
  }),

  async execute(_toolCallId, params, _signal, onUpdate, _ctx) {
    // Report progress for long operations
    onUpdate?.({
      content: [{ type: "text", text: "Working…" }],
      details: { step: "processing" },
    });

    return {
      content: [{ type: "text", text: "Done!" }], // sent to LLM
      details: { result: "…" }, // for rendering & state reconstruction
    };
  },
});

export function registerMyTool(pi: ExtensionAPI) {
  pi.registerTool(myTool);
}
```

**Key rules for tools:**

- Use `Type` from `@earendil-works/pi-ai` (not `typebox` directly).
- For string enums, use `StringEnum` from `@earendil-works/pi-ai` — `Type.Union`/`Type.Literal` don't work with Google's API.
- Always return `{ content, details }`. `content` goes to the LLM, `details` is for rendering and state.
- Throw to signal errors (returned values never set `isError`).
- Return `terminate: true` to skip the automatic follow-up LLM call (only when every tool in the batch is terminating).
- Truncate outputs to 50KB / 2000 lines. Import `truncateHead`, `truncateTail` from `@earendil-works/pi-coding-agent`.
- Use `withFileMutationQueue()` for tools that mutate files — prevents race conditions with parallel built-in `edit`/`write`.
- If a tool takes paths, normalize a leading `@` prefix (some models incorrectly add it).
- `prepareArguments(args)` runs before validation — use it to accept old schemas from resumed sessions.

**Overriding built-in tools:** Register a tool with the same name (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`). Your implementation must match the exact result shape (including `details` type). Rendering slots (`renderCall`/`renderResult`) fall back to the built-in renderer if omitted.

### 3. Commands

Slash-commands registered with `pi.registerCommand()`. The handler receives `args: string` (everything after the command name) and `ctx: ExtensionCommandContext`.

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerMyCommand(pi: ExtensionAPI) {
  pi.registerCommand("mycmd", {
    description: "What /mycmd does",

    handler: async (args: string, ctx) => {
      // Parse args
      const subcommand = args.trim();

      // Inspect session state
      const entries = ctx.sessionManager.getEntries();

      // User feedback
      ctx.ui.notify(`Found ${entries.length} entries`, "info");

      // Session control (only in commands, not event handlers)
      await ctx.waitForIdle();
      await ctx.newSession({/* ... */});
    },
  });
}
```

**Command-only context methods** (available on `ExtensionCommandContext`, NOT on `ExtensionContext`):

- `ctx.waitForIdle()` — await agent idle
- `ctx.newSession(opts)` — create a new session
- `ctx.fork(entryId, opts)` — fork from an entry
- `ctx.navigateTree(targetId, opts)` — navigate session tree
- `ctx.switchSession(path, opts)` — switch sessions
- `ctx.reload()` — reload extensions (treat as terminal: `await ctx.reload(); return;`)
- `ctx.getSystemPromptOptions()` — inspect what pi uses to build the system prompt

If multiple extensions register the same command name, each gets a numeric suffix: `/review:1`, `/review:2`.

### 4. Hooks (Event Handlers)

Subscribe to lifecycle events with `pi.on()`. Handlers receive `(event, ctx)`.

**Blocking pattern** (for `tool_call`, `session_before_*`):

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
    return { block: true, reason: "Dangerous command blocked" };
  }
  return undefined; // pass-through
});
```

**Modifying pattern** (for `context`, `before_agent_start`, `tool_result`):

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  return {
    systemPrompt: event.systemPrompt + "\n\nExtra instructions…",
    message: { customType: "my-ext", content: "Context", display: true },
  };
});
```

**Observation pattern** (for lifecycle tracking):

```typescript
pi.on("turn_end", async (event, ctx) => {
  pi.appendEntry("turn-timing", { duration: Date.now() - turnStart });
});
```

**`tool_call` specifics:**

- `event.input` is **mutable** — mutate in place to patch arguments before execution.
- Handler return values only control blocking: `{ block: true, reason?: string }`.
- Later handlers see mutations from earlier ones.
- Use `isToolCallEventType("name", event)` from `@earendil-works/pi-coding-agent` for typed input narrowing.

**Handler execution order:** Handlers run in extension load order. For session-before events, the first handler returning `{ cancel: true }` wins. For blocking events, the first handler returning `{ block: true }` wins.

### 5. Core Utilities

Pure functions with **zero pi API imports**. These are the highest-value tests because they're testable without any pi infrastructure.

```typescript
export function truncateAtWord(text: string, maxChars: number): string {
  // …
}

export function sanitizeLabel(input: string): string {
  // …
}

export function formatDuration(ms: number): string {
  // …
}
```

- Default-export each function for easy importing.
- Keep shared logic here. Tools/commands/hooks import from core, never the reverse.

---

## Event Reference

| Event                     | When                                 | Can Block?                 | Can Modify?                |
| ------------------------- | ------------------------------------ | -------------------------- | -------------------------- |
| `project_trust`           | Before project trust decision        | Yes (return `{ trusted })` | —                          |
| `session_start`           | Session loaded, created, or reloaded | No                         | No                         |
| `session_shutdown`        | Session being torn down              | No                         | No                         |
| `session_before_switch`   | Before `/new` or `/resume`           | Yes (`{ cancel })`         | —                          |
| `session_before_fork`     | Before `/fork` or `/clone`           | Yes (`{ cancel })`         | —                          |
| `session_before_compact`  | Before compaction                    | Yes (`{ cancel })`         | Yes (summary)              |
| `session_compact`         | After compaction completes           | No                         | No                         |
| `session_before_tree`     | Before `/tree` navigation            | Yes (`{ cancel })`         | Yes (summary)              |
| `session_tree`            | After `/tree` navigation             | No                         | No                         |
| `session_info_changed`    | Session name changed                 | No                         | No                         |
| `resources_discover`      | After `session_start`                | No                         | Yes (paths)                |
| `before_agent_start`      | Before agent loop starts             | No                         | Yes (sys prompt, message)  |
| `agent_start`             | Agent begins processing              | No                         | No                         |
| `agent_end`               | Agent stops processing               | No                         | No                         |
| `turn_start`              | Each turn begins                     | No                         | No                         |
| `turn_end`                | Each turn ends                       | No                         | No                         |
| `message_start`           | A message appears                    | No                         | No                         |
| `message_update`          | Streaming chunk received             | No                         | No                         |
| `message_end`             | Message finalized                    | No                         | Yes (replace message)      |
| `tool_execution_start`    | Tool execution begins                | No                         | No                         |
| `tool_execution_update`   | Tool streams progress                | No                         | No                         |
| `tool_execution_end`      | Tool execution done                  | No                         | No                         |
| `tool_call`               | Before tool executes                 | Yes (`{ block })`          | Yes (mutate `event.input`) |
| `tool_result`             | After tool executes                  | No                         | Yes (content, details)     |
| `context`                 | Before each LLM call                 | No                         | Yes (messages)             |
| `input`                   | User input received                  | Yes (`{ handled })`        | Yes (text, images)         |
| `user_bash`               | `!` / `!!` command executed          | Yes                        | Yes (operations)           |
| `model_select`            | Model changed                        | No                         | No                         |
| `thinking_level_select`   | Thinking level changed               | No                         | No                         |
| `before_provider_request` | Before HTTP request sent             | No                         | Yes (payload)              |
| `after_provider_response` | After HTTP response received         | No                         | No                         |

---

## ExtensionContext Reference

All event handlers receive `ctx: ExtensionContext`. Command handlers receive `ExtensionCommandContext` (extends `ExtensionContext`).

| Property / Method                         | Description                                             |
| ----------------------------------------- | ------------------------------------------------------- |
| `ctx.ui.notify(msg, level)`               | Show notification ("info", "warning", "error")          |
| `ctx.ui.confirm(title, msg, opts?)`       | Confirmation dialog → `boolean`                         |
| `ctx.ui.select(title, items)`             | Selection dialog → `string` or `undefined`              |
| `ctx.ui.input(title, placeholder?)`       | Text input → `string` or `undefined`                    |
| `ctx.ui.editor(title, prefill?)`          | Multi-line editor → `string` or `undefined`             |
| `ctx.ui.custom(cb, opts?)`                | Full custom TUI component → generic return              |
| `ctx.ui.setStatus(key, text)`             | Set footer status (clear with `undefined`)              |
| `ctx.ui.setWidget(key, lines)`            | Set widget above/below editor                           |
| `ctx.ui.setFooter(factory)`               | Replace footer (restore with `undefined`)               |
| `ctx.ui.setTitle(text)`                   | Set terminal title                                      |
| `ctx.ui.setEditorText(text)`              | Prefill editor                                          |
| `ctx.ui.getEditorText()`                  | Read editor content                                     |
| `ctx.ui.setToolsExpanded(boolean)`        | Expand/collapse tool outputs                            |
| `ctx.ui.addAutocompleteProvider(factory)` | Stack custom autocomplete                               |
| `ctx.mode`                                | `"tui"`, `"rpc"`, `"json"`, or `"print"`                |
| `ctx.hasUI`                               | `true` in TUI and RPC modes                             |
| `ctx.cwd`                                 | Current working directory                               |
| `ctx.signal`                              | AbortSignal during active turns (`undefined` when idle) |
| `ctx.isIdle()`                            | Whether agent is idle                                   |
| `ctx.isProjectTrusted()`                  | Whether project-local trust is active                   |
| `ctx.abort()`                             | Abort the current turn                                  |
| `ctx.shutdown()`                          | Request graceful shutdown                               |
| `ctx.compact(opts)`                       | Trigger compaction                                      |
| `ctx.getContextUsage()`                   | Token usage for active model                            |
| `ctx.getSystemPrompt()`                   | Current system prompt string                            |
| `ctx.sessionManager.getEntries()`         | All session entries                                     |
| `ctx.sessionManager.getBranch()`          | Current branch entries                                  |
| `ctx.sessionManager.getLabel(id)`         | Label for an entry                                      |
| `ctx.sessionManager.getSessionFile()`     | Session file path                                       |
| `ctx.modelRegistry.find(provider, model)` | Look up a model                                         |
| `ctx.model`                               | Currently active model                                  |

**Mode guard:** Use `ctx.mode === "tui"` before TUI-specific features (`custom()`, component factories). Use `ctx.hasUI` before dialog methods that work in both TUI and RPC.

---

## State Management

Extensions with mutable state should store it in tool result `details` for proper branching support:

```typescript
export default function (pi: ExtensionAPI) {
  let items: string[] = [];

  // Reconstruct on session_start
  pi.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "toolResult" && entry.toolName === "my_tool") {
        items = entry.details?.items ?? [];
      }
    }
  });

  pi.registerTool({
    name: "my_tool",
    execute() {
      items.push("new");
      return { content: [{ type: "text", text: "Added" }], details: { items: [...items] } };
    },
  });
}
```

For state that doesn't need branching, use `pi.appendEntry()`:

```typescript
pi.appendEntry("my-custom-type", { count: 42 });
```

`appendEntry` data is visible in `/tree` but NOT sent to the LLM. Reconstruct by iterating `ctx.sessionManager.getEntries()` on `session_start`.

---

## Dependencies

**Peer deps only** — provided by the pi runtime at load time:

```json
{
  "peerDependencies": {
    "@earendil-works/pi-ai": ">=0.75.0 <1.0.0",
    "@earendil-works/pi-coding-agent": ">=0.75.0 <1.0.0"
  }
}
```

| Package                           | Use                                                    |
| --------------------------------- | ------------------------------------------------------ |
| `@earendil-works/pi-coding-agent` | `ExtensionAPI`, `defineTool`, events, session types    |
| `@earendil-works/pi-ai`           | `Type` (schema builder), `StringEnum`                  |
| `@earendil-works/pi-tui`          | `Text`, custom components (`peerDep + devDep` if used) |

Node.js built-ins (`node:fs`, `node:path`, etc.) are available. npm dependencies work if a `package.json` with `dependencies` exists in or above the extension directory.

---

## Testing

Tests use vitest. Test files go in `src/__tests__/` or as `.test.ts` alongside source.

**What to test:**

- **Core utilities** — pure functions, highest value. No pi runtime needed.
- **Tool/command/hook logic** — test registration functions with a mock `ExtensionAPI`.
- Import from `src/index.ts` (barrel), never from `extension.ts` (its default export wires to a real API).

**What NOT to test:**

- Pi internals (event dispatch, session persistence, tool execution).
- The template's `extension.ts` wiring (it's glue code).
- Integration tests belong in a real extension repo.

**Red-Green-Refactor:**

1. Write the test first (red — it fails).
2. Write minimal code to make it pass (green).
3. Refactor while keeping tests green.
