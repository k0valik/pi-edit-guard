---
name: session-file-parsing
description: Deterministic drill-down analysis of pi JSONL session files. Inspect tool calls, custom entries, thinking blocks, and message structure across live or copied sessions. Use when reading, debugging, or summarizing a session.jsonl — also when chaining from another skill that needs a count of custom entries, a specific thinking-block segment, or a tool-call histogram. Do not use for editing sessions, replaying edit failures (use extract-session-fixtures), or for harness replay.
---

# Session File Parsing

## Philosophy

**Drill, don't browse.** The skill's job is narrowing, not reading. Every command should move from "I don't know what's in this file" to "here's the one thing I needed" in as few invocations as possible. The script encodes the narrowing; the agent supplies the intent.

Sessions are append-only trees over `parentId`, not linear streams. `tree`/`conversation` follow the active leaf→root path and **silently hide every other branch**. Anything that contradicts what the user sees in the pi UI is almost certainly on a hidden branch — fall back to `timeline` immediately. Original entries behind a `compaction` are **gone from the file**, not just hidden.

## Vocabulary

- **JSONL** — one JSON object per line. Line 1 is the `session` header, line N is the active leaf.
- **Entry** — top-level JSON object. Identified by `type` field.
- **Block** — an item inside `message.content[]` when `type === "message"`. Block types: `text`, `thinking`, `toolCall`.
- **`toolResult`** — a _separate entry_ of `type: "message"` with `role: "toolResult"`, NOT a block. Has its own `id` and `parentId`.
- **Builtin tools** — `read`, `write`, `edit`, `bash`. Anything else in a `toolCall` block is a **custom tool** (e.g. `recall`, `web_fetch`, `web_search`, `fetch_content`).
- **`customType`** — namespace-prefixed string on `type: "custom"` entries. Stable per source extension. **Do not hardcode** — new ones appear over time. May 2026 had `extmgr-auto-update`/`plannotator`/`web-search-results`; June added `om.observations.recorded`/`dirty-repo-guard`; June 21+ added `pi-cache-turn`/`edit-guard:*`/`pi-session-name-state`; later added `edit-guard:stormbreaker`/`session-config-pi-blackhole`.
- **Scope** — directory segment in `~/.pi/agent/sessions/`. Absolute cwd with each `/` replaced by `-`, wrapped in `--...--`. Single dash between segments, NOT double. `/home/kovalik/projects/pi-better-toolcalls` → `--home-kovalik-projects-pi-better-toolcalls--`.

## Pick a branch

```
What does the question look like?
├─ "How many / what kinds of X are in this file"     → drill (no filters), then drill --count with filters
├─ "Show me entries N through M"                       → show <file> <lines>
├─ "Find entries whose text matches a pattern"         → search
├─ "What does the active conversation look like"      → conversation or tree
├─ "What happened in chronological order, all branches" → timeline
├─ "Histogram of tool calls + errors"                  → tool-calls (with --by-file, --list, --args)
├─ "Read one specific section of a thinking block"     → drill --section thinking --segment N-M
└─ "The session looks corrupt / entries missing parent" → orphans
```

`drill` is the default for everything not pinned to a specific command. If unsure, run `drill <file>` first — it never modifies anything and reveals all dimensions (types, roles, customTypes, content sections, builtin vs custom tool calls).

## Execution Workflow

### Stage 1: Locate

Find the live session and inspect.

- Take intent what the user needs and what the investigation is for
- Was it a recent session?
- Was it related to a specific cwd? Scope the search for that cwd.
- Is the user asking for a specific thing they remember? Use keywords or ask them for a project name or a date range they could remember if not yet provided

```bash
# Find current project's sessions
SCOPE="--home-kovalik-projects-pi-better-toolcalls--"
ls -t ~/.pi/agent/sessions/"$SCOPE"/*.jsonl | grep -v '\.exit$' | head -1

# Cross-scope, sorted by date
find ~/.pi/agent/sessions/ -name "*.jsonl" -type f 2>/dev/null \
  | xargs -I{} sh -c 'head -1 "{}" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get(\"timestamp\",\"?\"))"' \
  | paste -d' ' <(find ~/.pi/agent/sessions/ -name "*.jsonl" -type f) -
```

### Stage 2: Overview

```bash
python3 .pi/skills/session-file-parsing/session-file-parsing.py drill <project>inspect.jsonl
```

Read the output as a **dimensions map**. Each section reveals one filter axis:

- Entry type distribution → `--type` values
- Message role distribution → `--role` values
- Custom entry distribution → `--custom` values (do not assume — read what is there)
- Content section types → `--section` values
- Tool calls split BUILTIN / CUSTOM → scope of tools used

**Completion criterion:** every dimension the user might ask about is visible. If a customType the user named does not appear, that is a finding — tell the user.

### Stage 3: Drill

Append filters left-to-right. Each filter narrows; the chain is cumulative.

```
drill <file>
  --type <t>             # entry.type
  --role <r>             # message.role (requires --type message)
  --custom <ct>          # customType (requires --type custom)
  --section <s>          # block.type inside message.content (text|thinking|toolCall)
  --keys                 # show available keys at current filter — STOP here, no data
  --show-data            # full content (default: 300-char preview)
  --show-edits           # op/oldText/newText breakdown per edit (with --section toolCall)
  --segment N-M          # extract lines N through M from matched content
  --limit N              # cap output rows
  --count                # print only the count
```

Drill pattern:

1. Broadest filter → look at output
2. Narrowest single addition → look at output
3. Repeat until the answer is in hand

When the user asks for "the Nth thinking block", the shortest path is:

```
drill <file> --type message --role assistant --section thinking --segment <N> --show-data --limit 1
```

When the user asks "how many custom `pi-cache-turn` entries are there":

```
drill <file> --type custom --custom pi-cache-turn --count
```

When the user asks "what tool calls exist and how often":

```
tool-calls <file>
# add --by-file for edit op breakdown + batch sizes
# add --list --args --limit N for chronological list with arguments
```

**Completion criterion:** the user's question is answered by the printed output. If not, narrow further.

### Stage 4: Cross-check against the active branch

When the output contradicts what the user saw in the pi UI, the active branch is hiding entries. Switch to `timeline` and compare:

```bash
python3 .pi/skills/session-file-parsing/session-file-parsing.py timeline <project>inspect.jsonl --limit 30
```

If entries the user saw are missing, look for `compaction` entries — their originals were **deleted**, not just hidden.

```bash
python3 .pi/skills/session-file-parsing/session-file-parsing.py search <project>inspect.jsonl "compaction|model_change" --mode fields
```

**Completion criterion:** either the contradiction is resolved (entries found in timeline, or compactions explained) or the user is told the data is gone.

## When stuck

- **`--type X --count` returns 0 but the user says X exists** → the type name is wrong. Run `drill <file>` (no filters) and read the entry type distribution. Report the actual name.
- **`drill --type custom --custom X` returns 0** → the customType name is wrong. Run `drill <file> --type custom` and read the custom entry distribution.
- **`tool-calls` shows tools the user didn't expect** → session was recorded with a different agent or extension set. Tools outside `{read, write, edit, bash}` are custom tools from an extension. Do not treat their presence as an error.
- **Output is truncated mid-tool-call** → add `--limit N` with a higher N, or use `--show-data` for fewer-but-fuller entries, or use `show <file> <line>` for one entry in full.
- **File > 50MB and the script feels slow** → first narrow with `--type`/`--role` filters to reduce entries processed; `--count` is cheapest; `--show-data` is most expensive.

## Anti-patterns

- **Reading a live session file** — always `cp` to /tmp/ first. Live files append mid-read.
- **Treating `toolResult` as a content block** — `toolResult` is a separate top-level entry with `role: "toolResult"`, not a block inside `message.content[]`. Filtering with `--section toolResult` inside a `--type message --role toolResult` drill is valid but filters blocks within that entry's own `content[]` (typically `text` blocks containing the result string).
- **Hardcoding customType names** — `pi-cache-turn` is not a constant of the schema. It appeared June 21, 2026 and may be replaced. The script must always read the custom entry distribution first.
- **Assuming a tool is "custom" or "builtin" without checking** — the rule is mechanical: `name in {read, write, edit, bash}` → builtin, else custom. The script enforces this. Do not second-guess by topic.
- **Reporting `drill` overview without reading its dimensions** — the overview is the map. Skimming it and going straight to a filter chain produces wasted invocations.
- **Following the active branch when the user wants the whole history** — `tree`/`conversation`/`drill` default to the file as written; `timeline` is the only chronological-across-branches view. Pick deliberately.
- **Calling the script without an absolute or known-cwd path** — the script is path-stable but `cd` mid-session breaks that. Always use `$(pwd)/.pi/skills/...` or absolute path.
- **Confusing line N in `show` with entry N in chronological order** — line N is the JSONL line number, which equals the append order, not the tree branch position.

## Done

**Completion criterion:** the user's question is answered concretely from printed output, with the exact filter chain that produced the answer shown in the response so the agent can re-derive it next time.

If no question was asked, the minimum useful artifact is:

1. Total entries + breakdown by type
2. Custom entry distribution with sample customTypes
3. Tool call split (builtin vs custom) with error rates
4. Active branch size vs total (highlight if branches are hidden)

## Scripts

- `.pi/skills/session-file-parsing/session-file-parsing.py` — single Python script. Args: command + file + flags. Outputs ANSI-colored text to stdout, errors to stderr. Exits non-zero on missing file or corrupt parse header.

## Chained skills

- For **session file format internals** (loaders, tree walks, compactions), read pi's `session-manager.js` in the installed `@earendil-works/pi-coding-agent` dist. This skill is a reader, not a reimplementation.
