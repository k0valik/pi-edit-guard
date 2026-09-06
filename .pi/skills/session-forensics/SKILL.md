---
name: session-forensics
description: Investigate pi session JSONL files — parse structure, trace parent-child trees, detect corruption, and understand what pi displays. Use when user reports missing conversation history, truncated sessions, resume issues, or asks about session file internals.
---

# Session Forensics

Investigate pi's JSONL session files.

## Script Location

The script lives in two locations:

- **System-wide:** `/home/kovalik/.pi/agent/.pi/skills/session-forensics/session-forensics.py`
- **Project-local:** `<project-root>/.pi/skills/session-forensics/session-forensics.py` (e.g. `/home/kovalik/projects/pi-utils/.pi/skills/session-forensics/session-forensics.py`)

If a project-local copy exists, prefer it (it may have project-specific fixes). Otherwise use the system-wide copy.

**Always use the absolute path** — never `cd` to a skill directory and call `python3 session-forensics.py` from there; the cwd-dependence is fragile.

System-wide example:

```bash
SCRIPT=/home/kovalik/.pi/agent/.pi/skills/session-forensics/session-forensics.py
python3 "$SCRIPT" types file.jsonl
```

Do **not** try `cd` to the session directory and run `python3 session-forensics.py` — the script lives in the skill directory, not the session directory.

## Quick Start

```bash
SCRIPT=/home/kovalik/.pi/agent/.pi/skills/session-forensics/session-forensics.py

# See entry-type overview (cap with --limit)
python3 "$SCRIPT" types file.jsonl --limit 5

# Active branch: root → leaf with previews (cap with --limit)
python3 "$SCRIPT" tree file.jsonl --limit 10

# Read the conversation (cap with --limit)
python3 "$SCRIPT" conversation file.jsonl --limit 5

# Chronological timeline of all events
python3 "$SCRIPT" timeline file.jsonl --limit 20

# Extract observations/reflections (om.observations/om.reflections)
python3 "$SCRIPT" observations file.jsonl

# Find orphan entries (parentId → missing entry)
python3 "$SCRIPT" orphans file.jsonl
```

### Search (regex by default)

```bash
# Single regex query — `|` is regex OR
python3 "$SCRIPT" search file.jsonl "fork-audit|W_STALE"

# Multi-term: match ANY (OR) — no need to craft regex
python3 "$SCRIPT" search file.jsonl --any "fork-audit" "stale anchor"

# Multi-term: match ALL (AND)
python3 "$SCRIPT" search file.jsonl --all "fork" "audit" "edit"

# Just count matches
python3 "$SCRIPT" search file.jsonl "fork-audit|W_STALE" --count

# Cap results to avoid flooding the terminal
python3 "$SCRIPT" search file.jsonl "fork|stale" --limit 5

# Include thinking blocks and tool calls
python3 "$SCRIPT" search file.jsonl "fork-audit" --mode all --limit 10

# Search raw JSON (good for finding tool names, file paths)
python3 "$SCRIPT" search file.jsonl "W_STALE_CONTEXT" --mode fields --limit 5
```

### Show entries

```bash
# Single entry
python3 "$SCRIPT" show file.jsonl 286

# Range
python3 "$SCRIPT" show file.jsonl 285-290

# Mixed list (single entries + ranges)
python3 "$SCRIPT" show file.jsonl 5 8 12 15-20

# Export as clean markdown
python3 "$SCRIPT" export file.jsonl --lines 285-290
```

## Finding Session Files

Session files live under `~/.pi/agent/sessions/<scope>/` where `<scope>` encodes the working directory.

### Scope naming

The scope is the **absolute cwd path with each `/` replaced by a single `-`**, then the whole thing wrapped in `--...--`. The `--` you see is **only** the leading/trailing wrapper — between path segments it's a single `-`.

| cwd                          | Scope directory                 |
| ---------------------------- | ------------------------------- |
| `/home/user`                 | `--home-user--`                 |
| `/home/user/projects/my-app` | `--home-user-projects-my-app--` |
| `/mnt/data/repos/something`  | `--mnt-data-repos-something--`  |
| `/home/user/.pi/agent`       | `--home-user-.pi-agent--`       |

⚠️ Common mistake: thinking each `/` becomes `--` between segments. It does **not**. Each `/` becomes a single `-`; the `--` you see is just the wrapper. The middle uses single dashes only.

### List sessions for a scope

```bash
# Scope for /home/user/projects/my-app:
SCOPE="--home-user-projects-my-app--"
ls ~/.pi/agent/sessions/"$SCOPE"/
# → 2026-06-18T18-05-59-141Z_019edbe9-....jsonl
# → 2026-06-18T19-44-18-952Z_019edc43-....jsonl
#   ...

# Get a quick overview of all files
for f in ~/.pi/agent/sessions/"$SCOPE"/*.jsonl; do
  lines=$(wc -l < "$f")
  size=$(du -h "$f" | cut -f1)
  first=$(head -1 "$f" | python3 -c "import sys,json; e=json.loads(sys.stdin.read()); print(e.get('timestamp','?')[:19])" 2>/dev/null || echo "?")
  echo "$(basename $f)  ${lines} entries  ${size}  from $first"
done
```

### Find sessions mentioning a pattern (across all scopes)

```bash
rg -al "session-forensics" ~/.pi/agent/sessions/ 2>/dev/null
```

## Understanding Session Scope: Active Branch vs. All Entries

### The tree model

Entries form a **tree via `parentId`**, not a linear sequence. Each entry points to its parent. The last entry in the file is the active leaf.

- `tree` and `conversation` follow the **active branch only** (leaf → parent → grandparent → ... → root)
- `timeline` shows **all entries chronologically** (every branch)
- Branches not on the leaf→root path are **invisible** to `tree`/`conversation`

### When branches get lost

Two things cause content to become invisible:

1. **Model changes** — When a session resumes with a different model, the new `model_change` entry becomes a new root. Everything on the old branch is still in the file but no longer on the active branch. `tree` won't show it, `timeline` will.

2. **Compactions** — Pi periodically compacts sessions. A `compaction` entry replaces a subtree with a summary. The original entries are **deleted from the file**. They are unrecoverable.

### How to detect missing content

```bash
# 1. Check for compactions
python3 "$SCRIPT" search file.jsonl "compaction" --mode fields --limit 5

# 2. Check for model changes (each one starts a new branch)
python3 "$SCRIPT" search file.jsonl "model_change" --mode fields --limit 10

# 3. Compare tree depth vs total entries
python3 "$SCRIPT" tree file.jsonl | head -3
# → "Active branch (42 of 310 entries)" ← 268 entries invisible to tree!

# 4. Use timeline to see what tree misses
python3 "$SCRIPT" timeline file.jsonl --limit 30
```

### What pi displays

Pi's `buildSessionContext()` walks the same leaf→root path. It shows **only the active branch** to the user. If any entry in that path has a `parentId` pointing to a missing entry, **everything above that break becomes invisible** in the pi UI too.

## Common Investigation Patterns

### I need to find a past conversation about X

```bash
# Quick check: how many matches?
python3 "$SCRIPT" search file.jsonl "some phrase" --count

# Search message text only (excludes thinking, tool calls, JSON keys)
python3 "$SCRIPT" search file.jsonl "some phrase" --limit 10

# Expand to thinking blocks and tool calls
python3 "$SCRIPT" search file.jsonl "some phrase" --mode all --limit 10

# Multi-term: match any of several topics
python3 "$SCRIPT" search file.jsonl --any "permission" "access denied" "403" --limit 10

# Search tool names and file paths in raw JSON
python3 "$SCRIPT" search file.jsonl "BashModeEditor" --mode fields --limit 5
```

### I need to understand a long, complex session

```bash
# 1. Check for compaction and branch splits first
python3 "$SCRIPT" search file.jsonl "compaction|model_change" --mode fields --limit 10

# 2. Get the entry-type overview
python3 "$SCRIPT" types file.jsonl --limit 5

# 3. See tree vs total — is content hidden?
python3 "$SCRIPT" tree file.jsonl --limit 15

# 4. Read the conversation active branch
python3 "$SCRIPT" conversation file.jsonl --limit 10

# 5. Full chronological view
python3 "$SCRIPT" timeline file.jsonl --limit 30

# 6. Extract observations/reflections
python3 "$SCRIPT" observations file.jsonl
```

### I need to extract a specific exchange from a session

```bash
# Find candidate lines with context
python3 "$SCRIPT" search file.jsonl "some topic" --limit 10

# Show entries in full
python3 "$SCRIPT" show file.jsonl 286
python3 "$SCRIPT" show file.jsonl 285-290
python3 "$SCRIPT" show file.jsonl 286 288 290 310-312

# Export as markdown
python3 "$SCRIPT" export file.jsonl --lines 285-290
```

### I think the session file is corrupted

```bash
# Entry-type overview — very few entries in a large file is suspicious
python3 "$SCRIPT" types file.jsonl

# Check for orphans (parentId points to missing entry)
python3 "$SCRIPT" orphans file.jsonl

# Parse errors appear at the top of any command as warnings
python3 "$SCRIPT" timeline file.jsonl --limit 5

# Validate JSON manually
python3 -c "
import json
with open('file.jsonl') as f:
    for i, line in enumerate(f, 1):
        try:
            json.loads(line.strip())
        except json.JSONDecodeError as e:
            print(f'Line {i}: {e}')
"
```

## Available Commands

| Command                     | Description                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types <file>`              | Entry type distribution with histogram. `--limit N` to cap                                                                                                                 |
| `tree <file>`               | Active branch: root → leaf with timestamps and previews. `--limit N` to cap                                                                                                |
| `timeline <file>`           | All entries in chronological order. `--limit N` to cap                                                                                                                     |
| `conversation <file>`       | Readable transcript along the active branch. `--limit N` to cap                                                                                                            |
| `search <file> <text>`      | Search using regex (default), `--any` (OR), or `--all` (AND). `--mode all` for text+thinking+toolCalls, `--mode fields` for raw JSON with snippets. `--limit N`, `--count` |
| `show <file> <lineSpec>`    | Show entries by single (286), range (285-290), or list (5 8 12 15-20)                                                                                                      |
| `observations <file>`       | Extract om.observations.recorded / om.reflections.recorded                                                                                                                 |
| `orphans <file>`            | Find entries whose parentId doesn't exist in the file                                                                                                                      |
| `export <file> --lines N-M` | Export line range as clean markdown                                                                                                                                        |

### Global options

| Option       | Effect                                        |
| ------------ | --------------------------------------------- |
| `--no-color` | Disable ANSI color output                     |
| `--quiet`    | Suppress non-essential output (for scripting) |

## JSONL Schema

Every line is one JSON object. Entry types:

| Type                    | Fields                                                    | Purpose                                                    |
| ----------------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `session`               | `version`, `id`, `timestamp`, `cwd`                       | File header (line 1)                                       |
| `message`               | `id`, `parentId`, `timestamp`, `message:{role,content,…}` | User/assistant/tool messages                               |
| `model_change`          | `id`, `parentId`, `timestamp`, `provider`, `modelId`      | Model/provider switch — creates a new branch root          |
| `thinking_level_change` | `id`, `parentId`, `timestamp`, `thinkingLevel`            | Thinking mode toggle                                       |
| `compaction`            | `id`, `parentId`, `timestamp`, `summary`, …               | Context window compaction — drops old branches permanently |
| `session_info`          | `id`, `parentId`, `name`                                  | Session naming                                             |
| `label`                 | `id`, `parentId`, `targetId`, `label`                     | Message labeling                                           |
| `custom`                | `id`, `parentId`, … (extension-defined)                   | Extension data                                             |

### Message `role` values (inside `message`)

- `"user"` — you typed something; `content` has `[{type:"text", text:"…"}]`
- `"assistant"` — agent reply; `content` has `thinking`, `text`, and/or `toolCall` blocks
- `"toolResult"` — result of a tool execution; `toolName`, `content`, `isError`

### Tool call pattern (assistant → toolResult)

```
user  →  assistant (with type:"toolCall" content)
                          ↓ toolResult (toolName + output)
       →  assistant (with type:"thinking" + type:"text")
                          ↓ toolResult
       →  assistant (final text response to user)
```

Each pair: the assistant emits a `toolCall`, pi executes it, records a `toolResult`, then the assistant continues with thinking/text.

## Known Pitfalls

These are things that have burned agents before. Read them once so you don't repeat the mistakes.

### Script path confusion

The script can live in two places (system-wide or project-local), and the skill you read may be either copy. The system-wide path is:

```
/home/kovalik/.pi/agent/.pi/skills/session-forensics/session-forensics.py
```

Project-local copies live at `<project-root>/.pi/skills/session-forensics/session-forensics.py` (e.g. `/home/kovalik/projects/pi-utils/.pi/skills/session-forensics/session-forensics.py`). It is **not** in the session directory, not in cwd.

Calling it without the full path gives `File not found`.

✅ **Always use the full absolute path** to whichever copy you're using. Don't rely on `cd` to a directory.

Why: pi loads skills from multiple paths. The script copy that gets used depends on which skill directory pi is reading from at the moment. The system-wide copy is the safe default; the project-local copy may have project-specific changes.

### Active branch ≠ full file

`tree` and `conversation` follow only the **active branch** (leaf → root). If the session was resumed after a model change, or if a branch was created and abandoned, those entries are **still in the file** but **invisible to tree/conversation**.

✅ Use `timeline` to see all entries chronologically. Check `tree` header for total vs. branch size to detect hidden content.

### Compactions delete data permanently

When pi runs compaction, it removes old branches and replaces them with a summary `compaction` entry. The original entries are gone — no search, no `show`, nothing.

✅ Check for `compaction` entries early. If the user's data was compacted, you need to explain that it's unrecoverable.

### Search modes mean different things

| Mode             | Searches                                  | Use case                                     |
| ---------------- | ----------------------------------------- | -------------------------------------------- |
| `text` (default) | user + assistant `"text"` blocks          | Finding conversation content                 |
| `all`            | text + thinking + toolCalls + toolResults | Finding agent reasoning or tool usage        |
| `fields`         | Raw JSON (every field)                    | Finding specific tool names, file paths, IDs |

`--mode fields` finds things the other modes miss (JSON keys, entry metadata), but also produces false positives from base64 content, file paths, and serialized data.

### Search is regex by default

Characters like `(`, `)`, `[`, `]`, `{`, `}`, `+`, `*`, `?`, `.`, `|` have special meaning. If you're searching for literal text containing these, **escape them with `\`** or use `--any` / `--all` which treat each argument as a literal substring (no regex).
Note: `--any` and `--all` take **multiple arguments**, each as a literal substring. They split the line on whitespace boundaries. If your query contains spaces, put it in quotes.

```bash
# Search for the literal string "fork (audit)" — no regex needed:
python3 "$SCRIPT" search file.jsonl --any "fork" "(audit)" --limit 5

# Or: escape the parens for the single-query regex path:
python3 "$SCRIPT" search file.jsonl "fork \(audit\)" --limit 5
```

**Common failure mode:** searching for JSON-shaped strings like `"role":"user"`. The double-quotes are fine, but the script does treat the query as regex; if you have a query that's mostly punctuation, prefer `--any` with the literal pieces:

```bash
# Searching for JSON role:user entries — single-query regex approach
python3 "$SCRIPT" search file.jsonl '"role":"user"' --mode fields --limit 5
```

If this returns "no matches" but you know the entries exist, the issue is regex interpretation. Switch to `--mode fields` and use a simpler literal pattern, or use `--any` with smaller fragments.

### Large sessions

For sessions with 500+ entries, always use `--limit` to avoid flooding the terminal. The script loads the entire file into memory — files over 50MB may take noticeable time.

### Out-of-range show specs

`show` silently skips out-of-range line numbers. If you request `show file 1-999` and the file has 100 entries, lines 101-999 produce no output but no error either.

## Deep Dive — Pi's Source

Session parsing code lives in pi's dist at:

```
~/.local/share/pnpm/store/v11/links/@earendil-works/pi-coding-agent/
    <version>/.../node_modules/@earendil-works/pi-coding-agent/dist/core/
```

Key files:

- **`session-manager.js`** — `loadEntriesFromFile()` (binary read + line split), `buildSessionContext()` (tree walk), `parseSessionEntryLine()` (JSON.parse wrapper that silently drops bad lines)
- **`agent-session.js`** — `exportToJsonl()` (export to linear JSONL rewriting parentIds), compaction logic

Search patterns:

```bash
rg "parseSessionEntryLine\|loadEntriesFromFile\|buildSessionContext" session-manager.js
rg "appendFileSync\|_persist\|_rewriteFile" session-manager.js
```
