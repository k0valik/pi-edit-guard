# Pi Extension Development Cheat Sheet

> Based on the official documentation and codebase implementation.

## 1. Core Objects

| Object                     | Purpose                        | Common Use Cases                                                              |
| -------------------------- | ------------------------------ | ----------------------------------------------------------------------------- |
| `ExtensionAPI` (pi)        | Extension capability interface | `pi.on()`, `pi.registerTool()`, `pi.registerCommand()`, `pi.sendMessage()`    |
| `ExtensionContext` (ctx)   | Runtime context                | `ctx.ui.notify()`, `ctx.sessionManager`, `ctx.model`, `ctx.signal`, `ctx.cwd` |
| `SessionBeforeSwitchEvent` | Session switch event type      | Parameter for `session_before_switch` event handlers                          |

The `ExtensionAPI` is created in the loader and provides registration methods that write to the extension object and action methods that delegate to the shared runtime [1](#0-0) . The `ExtensionContext` provides UI methods, session access, and runtime information [2](#0-1) .

## 2. Common Events (pi.on)

### Session Lifecycle

- `session_start` — Triggered on session startup/resume/reload, suitable for restoring state [3](#0-2)
- `session_before_switch` — Before switching sessions, can cancel the switch [4](#0-3)
- `session_shutdown` — Cleanup on exit [5](#0-4)
- `session_before_compact` — Before compaction, can customize instructions or cancel [6](#0-5)

### Agent Lifecycle

- `before_agent_start` — After user submits prompt, before agent starts, can inject system prompt [7](#0-6)
- `agent_start` / `agent_end` — Agent start/end processing [8](#0-7)
- `turn_start` / `turn_end` — Single LLM response + tool call turn [9](#0-8)

### Tool Interception

- `tool_call` — Before tool execution, can intercept/modify parameters [10](#0-9)
- `tool_result` — After tool execution, can modify results [11](#0-10)

### Input Processing

- `input` — After user input, before skill expansion, can transform or intercept [12](#0-11)

Additional events include `message_start`/`message_update`/`message_end`, `context`, `before_provider_request`/`after_provider_response`, `model_select`, `thinking_level_select`, and `user_bash` [13](#0-12) .

## 3. State Persistence Pattern

### Recommended: appendEntry + sessionManager recovery

```typescript
const MY_STATE_ENTRY = "my-state";

// 1. Save state
pi.appendEntry(MY_STATE_ENTRY, { count: 42 });

// 2. Restore state (in session_start)
pi.on("session_start", async (_event, ctx) => {
  for (let i = ctx.sessionManager.getEntries().length - 1; i >= 0; i--) {
    const entry = ctx.sessionManager.getEntries()[i];
    if (entry.type === "custom" && entry.customType === MY_STATE_ENTRY) {
      myState = entry.data;
      break;
    }
  }
});
```

**Why reverse search?** Because state changes are append-only, the newest entry is at the end. The `appendEntry` method appends custom entries to the session for state persistence (not sent to LLM) [14](#0-13) .

## 4. registerCommand vs registerTool

| Feature      | Command                                   | Tool                                             |
| ------------ | ----------------------------------------- | ------------------------------------------------ |
| Caller       | **User** types `/cmd`                     | **LLM** calls automatically                      |
| Parameters   | Raw string `args`                         | TypeBox schema-defined structured parameters     |
| Return Value | None (direct UI/message operations)       | Must return `{ content, details }`               |
| Registration | `pi.registerCommand("name", { handler })` | `pi.registerTool({ name, parameters, execute })` |
| Typical Use  | Quick commands, system operations         | File I/O, code execution, external APIs          |

Commands are registered with a name and handler options [15](#0-14) , while tools are registered with a full definition including parameters and execute function [16](#0-15) .

## 5. TUI Interaction

### Basic Notifications

```typescript
ctx.ui.notify("Hello", "info"); // info | warning | error | success
ctx.ui.setStatus("my-key", "text"); // Footer status
ctx.ui.setWidget("my-key", ["Line1", "Line2"]); // Widget above editor
```

### Simple Dialogs

```typescript
const ok = await ctx.ui.confirm("Title", "Are you sure?");
const input = await ctx.ui.input("Label", "default");
const choice = await ctx.ui.select("Pick:", ["A", "B", "C"]);
```

### Custom TUI (Complex Interaction)

```typescript
import { Container, SelectList, Text } from "@earendil-works/pi-tui";

const result = await ctx.ui.custom<string>((tui, theme, kb, done) => {
  const container = new Container();
  container.addChild(new Text(theme.fg("accent", "Hello")));

  return {
    render(width) {
      return container.render(width);
    },
    invalidate() {
      container.invalidate();
    },
    handleInput(data) {
      if (data === "q") done("quit");
    },
  };
});
```

UI methods are available through `ctx.ui` which is an `ExtensionUIContext` [17](#0-16) . Use `ctx.mode === "tui"` to guard terminal-only features and `ctx.hasUI` for dialog-capable UI (true in TUI and RPC modes) [18](#0-17) .

## 6. Three Ways to Send Messages

### 1. Send custom message (no turn trigger)

```typescript
pi.sendMessage({ customType: "x", content: "...", display: true });
```

### 2. Send message and trigger LLM response

```typescript
pi.sendMessage(
  { customType: "x", content: "...", display: true },
  { triggerTurn: true, deliverAs: "followUp" },
);
```

### 3. Simulate user message

```typescript
pi.sendUserMessage("continue", { deliverAs: "followUp" });
```

**`deliverAs` differences:**

- `"steer"` — Delivered after current turn finishes executing tool calls, before next LLM call
- `"followUp"` — Waits for agent to finish completely, delivered when agent has no more tool calls
- `"nextTurn"` — Queued for next user prompt, does not interrupt or trigger anything

The `sendMessage` method accepts options for delivery mode and turn triggering [19](#0-18) , while `sendUserMessage` always triggers a turn and requires `deliverAs` when streaming [20](#0-19) .

## 7. Plan Mode Design Pattern

Subtask-driven loop pattern for planning:

```typescript
// 1. Define task structure
type Task = { id: number; description: string; criteria: string[]; passes: boolean };

// 2. Submit plan tool
pi.registerTool({
  name: "submit_plan",
  parameters: Type.Object({
    tasks: Type.Array(
      Type.Object({
        description: Type.String(),
        criteria: Type.Array(Type.String()),
      }),
    ),
  }),
  async execute(_id, params, _sig, _upd, ctx) {
    tasks = params.tasks.map((t, i) => ({ id: i + 1, ...t, passes: false }));
    currentTaskIndex = 0;
    // Update prompt to enter execution phase
    return { content: [{ type: "text", text: "Plan submitted" }] };
  },
});

// 3. Advance task
pi.registerTool({
  name: "mark_task_done",
  parameters: Type.Object({}),
  async execute() {
    tasks[currentTaskIndex].passes = true;
    currentTaskIndex++;
    if (currentTaskIndex >= tasks.length) {
      // All complete, end loop
    }
    // Otherwise update prompt to enter next task
  },
});
```

Tools can be registered dynamically during extension load or after startup via `pi.registerTool()` [21](#0-20) .

## 8. Debugging Tips

### 1. Quick test extension

```bash
pi -e ./my-extension.ts
```

### 2. Hot reload

Place extensions in `~/.pi/agent/extensions/` or `.pi/extensions/`, then in pi:

```
/reload
```

### 3. RPC mode skip TUI

Many extensions return early in RPC mode to avoid TUI errors:

```typescript
if (ctx.mode === "rpc") return;
```

### 4. Check type errors

```bash
cd ~/.pi/agent/extensions && npx tsc --noEmit my-extension.ts
```

### 5. View session entries

Print session structure in extension:

```typescript
console.log(JSON.stringify(ctx.sessionManager.getEntries(), null, 2));
```

Extensions are auto-discovered from global (`~/.pi/agent/extensions/`) and project-local (`.pi/extensions/`) directories [22](#0-21) .

## 9. Common Imports

```typescript
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
```

Available packages include `@earendil-works/pi-coding-agent` for types, `typebox` for schemas, `@earendil-works/pi-ai` for AI utilities, and `@earendil-works/pi-tui` for TUI components [23](#0-22) .

## 10. Golden Rules

1. **State persistence with `appendEntry`** — Don't rely only on in-memory variables [14](#0-13)
2. **Guard TUI components with `ctx.hasUI`** — RPC/print modes need graceful degradation [24](#0-23)
3. **Use `ctx.signal` for long operations** — Supports cancellation and interruption [25](#0-24)
4. **Use `withFileMutationQueue` for file-modifying tools** — Avoids parallel conflicts
5. **Commands are for users, Tools are for LLMs** — Don't mix them up

## Notes

- Extensions can also register keyboard shortcuts via `pi.registerShortcut()` [26](#0-25) , CLI flags via `pi.registerFlag()` [27](#0-26) , and custom message renderers via `pi.registerMessageRenderer()` [28](#0-27) .
- The extension system was previously called "hooks" and "custom tools" — types were renamed in a migration (e.g., `HookAPI` → `ExtensionAPI`) [29](#0-28) .
- Extensions can be shared as pi packages via npm or git [30](#0-29) .

Wiki pages you might want to explore:

- [Glossary (earendil-works/pi)](/wiki/earendil-works/pi#11)
- [Extension System (earendil-works/pi)](/wiki/earendil-works/pi#6)

### Citations

**File:** packages/coding-agent/src/core/extensions/loader.ts (L212-283)

```typescript
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	const api = {
		// Registration methods - write to extension
		on(event: string, handler: HandlerFn): void {
			runtime.assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		registerTool(tool: ToolDefinition): void {
			runtime.assertActive();
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			runtime.assertActive();
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.ts").ExtensionContext) => Promise<void> | void;
			},
		): void {
			runtime.assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			runtime.assertActive();
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			runtime.assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			runtime.assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			runtime.assertActive();
			runtime.sendMessage(message, options);
		},
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L124-168)

```typescript
export interface ExtensionUIContext {
	/** Show a selector and return the user's choice. */
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a confirmation dialog. */
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	/** Show a text input dialog. */
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a notification to the user. */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/** Listen to raw terminal input (interactive mode only). Returns an unsubscribe function. */
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/** Set status text in the footer/status bar. Pass undefined to clear. */
	setStatus(key: string, text: string | undefined): void;

	/** Set the working/loading message shown during streaming. Call with no argument to restore default. */
	setWorkingMessage(message?: string): void;

	/** Show or hide the built-in interactive working loader row during streaming. */
	setWorkingVisible(visible: boolean): void;

	/**
	 * Configure the interactive working indicator shown during streaming.
	 *
	 * - Omit the argument to restore the default animated spinner.
	 * - Use `frames: ["●"]` for a static indicator.
	 * - Use `frames: []` to hide the indicator entirely.
	 * - Custom frames are rendered as provided, so extensions must add their own colors.
	 */
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;

	/** Set the label shown for hidden thinking blocks. Call with no argument to restore default. */
	setHiddenThinkingLabel(label?: string): void;

	/** Set a widget to display above or below the editor. Accepts string array or component factory. */
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L300-333)

```typescript
export interface ExtensionContext {
  /** UI methods for user interaction */
  ui: ExtensionUIContext;
  /** Current run mode. Use "tui" to guard terminal-only UI such as custom components. */
  mode: ExtensionMode;
  /** Whether dialog-capable UI is available (true in TUI and RPC modes) */
  hasUI: boolean;
  /** Current working directory */
  cwd: string;
  /** Session manager (read-only) */
  sessionManager: ReadonlySessionManager;
  /** Model registry for API key resolution */
  modelRegistry: ModelRegistry;
  /** Current model (may be undefined) */
  model: Model<any> | undefined;
  /** Whether the agent is idle (not streaming) */
  isIdle(): boolean;
  /** Whether project-local trust is active for this context. */
  isProjectTrusted(): boolean;
  /** The current abort signal, or undefined when the agent is not streaming. */
  signal: AbortSignal | undefined;
  /** Abort the current agent operation */
  abort(): void;
  /** Whether there are queued messages waiting */
  hasPendingMessages(): boolean;
  /** Gracefully shutdown pi and exit. Available in all contexts. */
  shutdown(): void;
  /** Get current context usage for the active model. */
  getContextUsage(): ContextUsage | undefined;
  /** Trigger compaction without awaiting completion. */
  compact(options?: CompactOptions): void;
  /** Get the current effective system prompt. */
  getSystemPrompt(): string;
}
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1135-1135)

```typescript
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1136-1139)

```typescript
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1142-1144)

```typescript
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1146-1146)

```typescript
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1149-1170)

```typescript
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
	on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): void;
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1171-1171)

```typescript
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1177-1180)

```typescript
	/** Register a tool that the LLM can call. */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1186-1187)

```typescript
	/** Register a custom command. */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1189-1196)

```typescript
	/** Register a keyboard shortcut. */
	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1198-1206)

```typescript
	/** Register a CLI flag. */
	registerFlag(
		name: string,
		options: {
			description?: string;
			type: "boolean" | "string";
			default?: boolean | string;
		},
	): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1215-1216)

```typescript
	/** Register a custom renderer for CustomMessageEntry. */
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1222-1226)

```typescript
	/** Send a custom message to the session. */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1232-1235)

```typescript
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;
```

**File:** packages/coding-agent/src/core/extensions/types.ts (L1237-1238)

```typescript
	/** Append a custom entry to the session for state persistence (not sent to LLM). */
	appendEntry<T = unknown>(customType: string, data?: T): void;
```

**File:** packages/coding-agent/docs/extensions.md (L114-119)

```markdown
| Location                            | Scope                        |
| ----------------------------------- | ---------------------------- |
| `~/.pi/agent/extensions/*.ts`       | Global (all projects)        |
| `~/.pi/agent/extensions/*/index.ts` | Global (subdirectory)        |
| `.pi/extensions/*.ts`               | Project-local                |
| `.pi/extensions/*/index.ts`         | Project-local (subdirectory) |
```

**File:** packages/coding-agent/docs/extensions.md (L138-145)

```markdown
## Available Imports

| Package                           | Purpose                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `@earendil-works/pi-coding-agent` | Extension types (`ExtensionAPI`, `ExtensionContext`, events) |
| `typebox`                         | Schema definitions for tool parameters                       |
| `@earendil-works/pi-ai`           | AI utilities (`StringEnum` for Google-compatible enums)      |
| `@earendil-works/pi-tui`          | TUI components for custom rendering                          |
```

**File:** packages/coding-agent/docs/extensions.md (L896-900)

```markdown
Current run mode: `"tui"`, `"rpc"`, `"json"`, or `"print"`. Use `ctx.mode === "tui"` to guard terminal-only features such as `custom()`, component factories, terminal input, and direct TUI rendering.

### ctx.hasUI

`true` in TUI and RPC modes. `false` in print mode (`-p`) and JSON mode. Use this to guard dialog methods (`select`, `confirm`, `input`, `editor`) and fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`) that work in both TUI and RPC modes. In RPC mode, some TUI-specific methods are no-ops or return defaults (see [rpc.md](rpc.md#extension-ui-protocol)).
```

**File:** packages/coding-agent/docs/extensions.md (L942-952)

```markdown
### ctx.signal

The current agent abort signal, or `undefined` when no agent turn is active.

Use this for abort-aware nested work started by extension handlers, for example:

- `fetch(..., { signal: ctx.signal })`
- model calls that accept `signal`
- file or process helpers that accept `AbortSignal`

`ctx.signal` is typically defined during active turn events such as `tool_call`, `tool_result`, `message_update`, and `turn_end`.
It is usually `undefined` in idle or non-turn contexts such as session events, extension commands, and shortcuts fired while pi is idle.
```

**File:** packages/coding-agent/docs/extensions.md (L1291-1292)

```markdown
`pi.registerTool()` works both during extension load and after startup. You can call it inside `session_start`, command handlers, or other event handlers. New tools are refreshed immediately in the same session, so they appear in `pi.getAllTools()` and are callable by the LLM without `/reload`.
```

**File:** packages/coding-agent/CHANGELOG.md (L3251-3262)

```markdown
**Type renames:**

- `HookAPI` → `ExtensionAPI`
- `HookContext` → `ExtensionContext`
- `HookCommandContext` → `ExtensionCommandContext`
- `HookUIContext` → `ExtensionUIContext`
- `CustomToolAPI` → `ExtensionAPI` (merged)
- `CustomToolContext` → `ExtensionContext` (merged)
- `CustomToolUIContext` → `ExtensionUIContext`
- `CustomTool` → `ToolDefinition`
- `CustomToolFactory` → `ExtensionFactory`
- `HookMessage` → `CustomMessage`
```

**File:** packages/coding-agent/README.md (L398-420)

````markdown
### Pi Packages

> **Security:** Pi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
pi install npm:@foo/pi-tools
pi install npm:@foo/pi-tools@1.2.3      # pinned version
pi install git:github.com/user/repo
pi install git:github.com/user/repo@v1  # tag or commit
pi install git:git@github.com:user/repo
pi install git:git@github.com:user/repo@v1  # tag or commit
pi install https://github.com/user/repo
pi install https://github.com/user/repo@v1      # tag or commit
pi install ssh://git@github.com/user/repo
pi install ssh://git@github.com/user/repo@v1    # tag or commit
pi remove npm:@foo/pi-tools
pi uninstall npm:@foo/pi-tools          # alias for remove
pi list
pi update                               # update pi only
pi update --all                         # update pi and packages
pi update --extensions                  # update packages only
```
````
