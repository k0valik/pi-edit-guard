# Tool Description Writer

## Philosophy

Pi's system prompt delivers tool information through three separate channels: Available tools (name: snippet), Guidelines (flat named bullets), and function schemas (description + parameter descriptions). The model reads all three as complementary signals — it does not deduplicate. Putting the same fact in two channels both wastes tokens and confuses which layer is authoritative.

The goal is _signal density_: every token pulls the model toward the correct tool, not toward skipping paste. Brevity alone is not the goal — the tool must still command attention through clear, decisive language that makes the model reach for it natively. A tight, well-placed description beats a verbose wall that gets skimmed over.

Write for the agent that reads these texts every turn. Every extraneous sentence is a permanent tax.

## Vocabulary

- **description** — the `description` field in ToolDefinition. Appears in the function schema the LLM sees per-call alongside parameter definitions.
- **promptSnippet** — the `promptSnippet` field. One-liner in the Available tools list (tool name: snippet).
- **promptGuidelines** — the `promptGuidelines` field (string[]). Each string is a bullet in the flat Guidelines section, mixed with bullets from other tools. No grouping by tool.
- **param description** — the `description` field on each TypeBox parameter. Appears with the parameter in the function schema.
- **Layer** — one of {Available tools, Guidelines, function schema}. Each has a distinct rendering purpose.

## Workflow

### Stage 1: Gather

Read the tool's current `description`, `promptSnippet`, `promptGuidelines`, and each param's `description`. For new tools (no existing text), skip to Stage 3.

If you haven't read pi's prompt architecture this session, read `references/pi-architecture.md` first — the rendering rules determine what each layer can express.

### Stage 2: Classify and triage

For each sentence across all fields, tag it:

- **kind**: `routing`, `safety`, `behavior`, `schema detail`, `implementation`
- **destination**: routing → Guidelines, safety → Guidelines, behavior → description or snippet, schema detail → param description, implementation → **DELETE**

**Gate**: Do not proceed until every sentence is tagged with kind and destination.

### Stage 3: Write each layer

Write each field from scratch. Do not copy phrasing — rephrase per layer constraints.

**`description`** (function schema):

- 1-3 sentences. First: high-level purpose. Second (optional): what distinguishes it. Third (optional): usage hint.
- State _what_ the tool does, not _how_.
- Make it decisive — a model scanning 10 descriptions should land on this one.
- Example: "Syntax-aware code search with preset modes (calls/imports/...) or custom AST patterns."

**`promptSnippet`** (Available tools one-liner):

- At most 80 characters. One line, no breaks.
- Strictly shorter than the description. It is a scan target, not a specification.
- Can be omitted — tools without snippets are still callable, just don't appear in Available tools.
- Example: "Structural code search with preset modes or AST patterns"

**`promptGuidelines`** (Guidelines section — flat, mixed with other tools):

- 1-3 bullets maximum per tool.
- Each bullet MUST backtick the tool name (`tool_name`). Guidelines has no grouping — backticks are the model's only visual anchor.
- Only routing decisions and critical safety notes. Never schema defaults, allowed values, exclusions, or parameter relationships.
- Test: "Would the model still make the right choice if this bullet were missing?" If yes, delete.
- Example: "Use `tool_name` for structural queries before grep/rg."
- Example: "`tool_name` dry-run is the default (dryRun=true). Always review before applying."

**`param description`** (per-parameter):

- Tell the agent what value to supply, not how the tool uses it internally.
- Do not restate type constraints (TypeBox expresses min/max/enum).
- Do not include implementation rationale ("needed for the two-pass architecture").
- Do state behavioral effect and non-obvious relationships to other params.
- Test: "If the agent has never used this tool, would this description be enough to fill in the parameter?"

### Stage 4: Audit for round-trip

Read the result as a first-time observer:

1. Does the `description` alone let me guess the tool's purpose?
2. Does the `promptSnippet` disambiguate from similar-named tools in the Available tools list?
3. If I only saw Guidelines, would I know which tool each bullet belongs to? (Backticks fix this.)
4. Is any fact repeated across layers? If yes, pick one layer and delete from the rest.
5. Count total chars in Guidelines. If >300 across all tools, tighten.

### Stage 5: Validate

Run `scripts/audit-descriptions.py` with the rewritten tool definitions piped via stdin. Fix all findings before reporting.

### Stage 6: Apply

Replace the field values in `pi.registerTool()`. Rebuild the system prompt (reload pi) and verify the rendered output shows token reduction and clear tool identity.

## When stuck

If you cannot decide between two layers: put it in `description`. The model sees it per-call. Moving it out later is easier than recovering from a missing signal.

If a tool has >3 safety constraints: bundle into one guideline bullet ("See `tool_name` `description` for parameter rules") and put details in description. Guidelines must stay scannable.

If pi's prompt architecture changes (new version): read updated pi docs before writing. Layer assignments depend on rendering behavior.

## Anti-patterns

- **Snippet == description**: If `promptSnippet` is identical to the first `description` sentence, one is wasted. Shorten the snippet.
- **Guidelines as schema docs**: Putting parameter defaults, allowed values, mutual exclusions, or examples in Guidelines. These belong in param descriptions. Exception: one safety-critical default (e.g., "dry-run is the default").
- **Routing in snippet**: Using `promptSnippet` to explain when to use this vs another tool. Routing belongs in Guidelines.
- **Implementation leak**: Describing internal architecture in any layer ("needed for the two-pass architecture"). The agent needs to decide _whether_ to call and _what_ to pass — not _how_ it works.
- **Naked tool names in Guidelines**: Writing "Use my_tool when..." without backticks. In a flat list of 10+ bullets, the model skims and may miss the name.
- **Verbose param descriptions**: Repeating type constraints TypeBox already expresses. Add behavioral context instead.
- **Token padding**: "Please note that", "This parameter is used for", "It is important to understand". Every token is permanent overhead per turn.

## Done

Complete when:

1. Every field rewritten per its layer.
2. No fact in more than one layer.
3. `scripts/audit-descriptions.py` passes with zero findings.
4. Guidelines: at most 3 bullets per tool, all backticked.
5. Token reduction measurable (compare total chars before/after).
6. The `description` would let a model scanning a tool list pick the right tool.

## Scripts

- `scripts/audit-descriptions.py` — Validate tool description JSON against anti-patterns. Reads a JSON array of tool definition objects from stdin, prints findings to stdout, exits non-zero on any finding. Each finding includes field path, violated rule, and fix suggestion.

## References

- `references/pi-architecture.md` — How pi constructs the system prompt from the three layers. Rendering rules determine which information belongs in which layer. Read when you need to verify rendering behavior for a specific layer.
