# How pi-coding-agent builds the system prompt and tool definitions

This is the architecture reference for "where does the model see what" when an
extension registers a tool. Useful when you're deciding what belongs in the
`promptSnippet`, the `description`, the `promptGuidelines`, or the AJV field
descriptions — and which of those the model actually reads.

**Audience:** pi-utils extension authors.

---

## TL;DR

A tool's text is split across **four** places, with very different visibility:

| Layer                                           | Where the model sees it                   | Visibility                             |
| ----------------------------------------------- | ----------------------------------------- | -------------------------------------- |
| `ToolDefinition.promptSnippet` (one-line `.md`) | System prompt, `Available tools:` list    | **Always** in every-turn context       |
| `ToolDefinition.description` (multi-line `.md`) | Tool block in the LLM API call (per turn) | Per turn, in the tool definition       |
| `ToolDefinition.promptGuidelines` (bullet list) | System prompt, `Guidelines:` list         | **Always** in every-turn context       |
| AJV `parameters.*.description` (per-field docs) | Same tool block, inside the JSON schema   | Per turn, when the model fills a field |

A common mistake is treating all four as "docs for the model" and writing the
same thing four times. They are not equivalent — keep them distinct.

---

## What goes in the system prompt (always in context)

Source: `node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js`

The function `buildSystemPrompt(options)` (line 8) assembles the prompt. The
relevant sections:

```js
// system-prompt.js:49-51
const tools = selectedTools || ["read", "bash", "edit", "write"];
const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
const toolsList =
  visibleTools.length > 0
    ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n")
    : "(none)";
```

```js
// system-prompt.js:80
const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
```

```js
// system-prompt.js:81-98
let prompt = `You are an expert coding assistant operating inside pi, ...
Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools ...

Guidelines:
${guidelines}
...`;
```

What this means:

- The system prompt contains **only** the `promptSnippet` (one line per tool,
  rendered as `- <name>: <snippet>`) and the `promptGuidelines` (deduplicated
  bullet list under `Guidelines:`).
- The full `description` and the `parameters` schema are **not** in the
  system prompt. They go in the tool block sent to the LLM API.
- If a tool has no `promptSnippet`, it does not appear in the `Available
tools:` list at all (the comment at line 48-49 says so explicitly: _"A tool
  appears in Available tools only when the caller provides a one-line
  snippet."_). It can still be used; the model just doesn't see it announced
  in the system prompt.
- `promptGuidelines` are global, not per-tool — they accumulate from every
  tool that defines them, then get deduplicated. The base system prompt
  always appends two extra bullets at lines 78-79:
  - `"Be concise in your responses"`
  - `"Show file paths clearly when working with files"`

The system prompt is also where the docs links live (line 91+), so anything
your extension tells the model about pi itself should land in `promptSnippet`
or `promptGuidelines`, not in `description`.

## What goes in the LLM API tool block (per-turn)

Source: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
and `node_modules/@earendil-works/pi-ai/dist/types.d.ts`

The `ToolDefinition` (extensions types.d.ts:333-364) and the underlying `Tool`
type (pi-ai types.d.ts:239-243):

```ts
// pi-ai types.d.ts:239
export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}
```

```ts
// extensions types.d.ts:333
export interface ToolDefinition<TParams, TDetails, TState>
    extends Tool<TParams> {
    label: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    renderShell?: "default" | "self";
    prepareArguments?: (args: unknown) => Static<TParams>;
    executionMode?: ToolExecutionMode;
    execute(...): Promise<AgentToolResult<TDetails>>;
    renderCall?(...);
    renderResult?(...);
}
```

`Tool` is what the agent runtime turns into the tool block in the LLM API
call. So the LLM receives:

```json
{
  "name": "edit",
  "description": "<full .md content>",
  "parameters": {/* AJV JSON schema with field-level descriptions */}
}
```

The model sees this **on every turn it might use the tool**, not every turn
unconditionally. (`ToolInfo` in extensions types.d.ts:1058 confirms this is
the public shape: `Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines">`.)

Practical implications:

- **`description` and field-level AJV `description:` are both visible to the
  model** whenever the tool could be called. The model reads them when it
  needs to figure out what to put in a field.
- Field-level descriptions inside the parameters JSON schema are first-class
  model-visible text. Clean them up the same way you'd clean the main
  `description`.
- The model does **not** see `label`, `renderShell`, `executionMode`, or any
  of the rendering callbacks — those are for the pi TUI, not the LLM.

---

## How an extension replaces a built-in tool

`pi-hashline-edit` registers an `edit` tool to override the built-in. Here's
how that works.

Source: `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`

The tool registry (`_toolRegistry`) is a `Map<name, RegisteredTool>`
(agent-session.js:109, 1819-1844):

```js
// agent-session.js:1841-1844
for (const tool of allCustomTools) {
  definitionRegistry.set(tool.definition.name, {
    definition: tool.definition,
    sourceInfo: tool.sourceInfo,
  });
}
```

So extension-registered tools **win over built-ins by name**. Both the
`promptSnippet` shown in the system prompt and the `description` +
`parameters` sent in the LLM tool block come from the extension's
definition, not the built-in.

`getAllTools()` (agent-session.js:525-533) is the user-facing API for this:

```js
return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
  name: definition.name,
  description: definition.description,
  parameters: definition.parameters,
  promptGuidelines: definition.promptGuidelines,
  sourceInfo,
}));
```

That's the exact set of fields the host surfaces to extensions. Note
`promptSnippet` is not in this list — it only affects the system prompt, not
any host-facing API.

---

## Why this leads to the "duplication" smell

When you write a tool you naturally want the model to "know" how to use it.
A common pattern is:

```md
edit-snippet.md: "Edit a text file. Submit one call per file. ..."
edit.md: "Edit a text file using line ranges, substring replacement, or line insertion. ..." (full)
promptGuidelines: "- Always copy full endpoint lines like `128qw7│    return value`"
parameters.edits.description: "REQUIRED: 1+ edit entries. ..."
parameters.oldText.description: "Must occur EXACTLY ONCE in the file."
```

Five places, same idea: "use full checked endpoint lines, single-line matches,
submit one call per file". The model only sees the snippet in the system
prompt on every turn; the rest is competing for the same context budget on
the tool block. The information does not get richer by being repeated — it
just takes more tokens to read.

**Recommended split:**

| Field                      | What belongs there                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptSnippet`            | One-line _summary_. The model reads this on every turn. Keep it short.                                                                                                                                   |
| `description`              | Full user-facing docs: ops, syntax, examples, common mistakes. The model reads this when it considers the tool.                                                                                          |
| `promptGuidelines`         | Cross-cutting rules that apply whenever this tool is active, not specific to a field. (e.g. "Use read before edit when you don't have current line refs.") Avoid duplicating `description` content here. |
| `parameters.*.description` | Per-field docs: what's in this field, what shape, what constraints. The model reads this when it needs to fill a field. Should not duplicate `description` content.                                      |

Rule of thumb: if a sentence would still make sense without the rest of the
docs, put it in `description`. If a sentence applies to a single field
(range, pos, oldText, …), put it in that field's AJV description. If a
sentence applies to a single one-liner summary, put it in `promptSnippet`.
If a sentence is a general rule about how to use this tool family, put it
in `promptGuidelines`.

---

## Quick orientation: where to look in source

| Question                                                   | File                                                                   | Symbol                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| How is the system prompt assembled?                        | `dist/core/system-prompt.js`                                           | `buildSystemPrompt()` (line 8)                                               |
| What part of the system prompt shows tools?                | same file                                                              | `toolsList` (line 50-51), rendered at line 84                                |
| What part shows guidelines?                                | same file                                                              | `guidelines` (line 80), rendered at line 89                                  |
| What are the always-on guidelines?                         | same file                                                              | lines 78-79                                                                  |
| What does a `ToolDefinition` look like?                    | `dist/core/extensions/types.d.ts`                                      | `ToolDefinition` (line 333)                                                  |
| What does the LLM actually receive?                        | `dist/core/extensions/types.d.ts` and `dist/.../pi-ai/dist/types.d.ts` | `Tool` (pi-ai:239) — `{name, description, parameters}`                       |
| What is the public tool info shape?                        | `dist/core/extensions/types.d.ts`                                      | `ToolInfo` (line 1058)                                                       |
| How does the tool registry merge built-ins and extensions? | `dist/core/agent-session.js`                                           | `_refreshToolRegistry()` (line 1818), `definitionRegistry.set()` (line 1841) |
| How does the host expose tools to extensions?              | same file                                                              | `getAllTools()` (line 525)                                                   |
| How does the system prompt get rebuilt when tools change?  | same file                                                              | `setActiveToolsByName()` (line 543), `_rebuildSystemPrompt()` (line 622)     |
| Example extension using `getAllTools()`                    | `examples/extensions/tools.ts`                                         | the `toolsExtension` function                                                |

All paths above are inside `node_modules/@earendil-works/pi-coding-agent/`
after `pnpm install`. The actual on-disk path goes through pnpm's content-
addressed store, e.g.
`node_modules/.pnpm/@earendil-works+pi-coding-agent@0.79.0/node_modules/@earendil-works/pi-coding-agent/dist/...`.
Find the real path with:

```bash
ls -d node_modules/.pnpm/@earendil-works+pi-coding-agent@*/node_modules/@earendil-works/pi-coding-agent
```

---

# Pi Prompt Architecture for Tools

How `buildSystemPrompt()` renders tool metadata into the system prompt the model sees every turn.

## Available tools section

Rendered as a bullet list. Only tools with a `promptSnippet` defined appear here. Tools without snippets are callable but invisible in this list.

```
Available tools:
- tool_name: promptSnippet text
- another_tool: Its snippet
```

Format: `"- " + tool_name + ": " + snippet`

## Guidelines section

Bullets from ALL active tools are appended flat into one list. No grouping by tool, no section headers, no tool name prefix. The only way to visually anchor a bullet to its tool is to backtick the tool name within the text.

Guidelines are deduplicated — exact duplicates are collapsed to one entry.

After extension-provided guidelines, two default bullets are always appended:

- "Be concise in your responses"
- "Show file paths clearly when working with files"

## Function schemas

Parameter schemas (TypeBox) are NOT rendered in the system prompt text. They are sent separately to the LLM provider in the API's `tools` array. For Anthropic, they go through `convertTools()` into `params.tools`. The model sees them as native function definitions.

Each tool's `description` field appears as the function's description in this provider-level schema.

## Prompt rebuild

When tools change (via `pi.setActiveTools()`), `_rebuildSystemPrompt()` collects snippets and guidelines from the current active tools and calls `buildSystemPrompt()`. Snippets and guidelines are gathered from the ToolDefinition metadata stored in `_toolPromptSnippets` and `_toolPromptGuidelines` maps.

Dynamic tools registered via `pi.registerTool()` after startup are available immediately without `/reload` — the system prompt rebuilds automatically.

## Key implications for tool description writers

1. **Available tools is the first filter**: The model scans the tool list to find what's available. A good snippet here means the model pauses and reads the full definition.
2. **Guidelines is the only shared context**: Since guidelines from all tools mix together, backticked names are essential. The model cannot otherwise tell which tool a guideline refers to.
3. **Function schema is per-call detail**: The model sees description + params when it considers a specific tool. This is where behavioral detail and parameter relationships belong.
4. **No cross-tool routing in schemas**: The function schema is shown per-tool — the model cannot compare tools there. Routing ("use X instead of Y") must be in Guidelines, which the model sees globally.
5. **Implementation details are invisible**: The model reads descriptions to decide _whether_ to call a tool, not to understand _how_ it works. Internal architecture is noise.
