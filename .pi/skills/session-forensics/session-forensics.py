#!/usr/bin/env python3
"""
Session Forensics - structured analysis of pi JSONL session files.

Usage:
  python3 session-forensics.py <command> <file> [options]

Commands:
  search       Search using regex (default), --any (OR), or --all (AND)
  show         Show entries by single, range (5-10), or list (5 8 12 15-20)
  tree         Trace the active parent-child branch
  conversation  Print readable conversation transcript
  observations  Extract observations and reflections
  orphans      Find entries whose parentId is missing
  types        Summarize entry type distribution
  timeline     Chronological event sequence
  export       Export lines as clean markdown

Global options:
  --no-color   Disable ANSI color output
  --quiet      Suppress non-essential output (for scripting)

Search options:
  --mode text|all|fields    Content scope (default: text)
  --any <q> [q...]          Match any of the queries (OR)
  --all <q> [q...]          Match all queries (AND)
  --limit N                 Cap results
  --count                   Show match count only

Other commands accept --limit N for output capping.

Examples:
  python3 session-forensics.py search session.jsonl "jump up"
  python3 session-forensics.py search session.jsonl "error|fail|timeout"  # regex OR
  python3 session-forensics.py search session.jsonl --any "error" "timeout"  # multi-term OR
  python3 session-forensics.py search session.jsonl --all "fork-audit" "edit" --limit 10
  python3 session-forensics.py search session.jsonl "W_STALE" --count
  python3 session-forensics.py show session.jsonl 286
  python3 session-forensics.py show session.jsonl 285-290  # range
  python3 session-forensics.py show session.jsonl 5 8 12 15-20  # mixed
  python3 session-forensics.py tree session.jsonl
  python3 session-forensics.py tree session.jsonl --limit 5
  python3 session-forensics.py conversation session.jsonl
  python3 session-forensics.py observations session.jsonl
  python3 session-forensics.py timeline session.jsonl --limit 20
"""

import json
import sys
import os
from datetime import datetime
from collections import Counter
import re


# ── ANSI helpers ──────────────────────────────────────────────────────────────

class Style:
    """Minimal ANSI styling — disabled with --no-color or when piped."""
    def __init__(self, enabled: bool):
        self.enabled = enabled

    def _c(self, code: int, s: str) -> str:
        return f"\033[{code}m{s}\033[0m" if self.enabled else s

    def bold(self, s):     return self._c(1, s)
    def dim(self, s):      return self._c(2, s)
    def blue(self, s):     return self._c(34, s)
    def green(self, s):    return self._c(32, s)
    def yellow(self, s):   return self._c(33, s)
    def red(self, s):      return self._c(31, s)
    def cyan(self, s):     return self._c(36, s)
    def magenta(self, s):  return self._c(35, s)
    def grey(self, s):     return self._c(90, s)
    def header(self, s):   return self._c(44, f" {s} ") if self.enabled else f"[{s}]"


# ── Loading ───────────────────────────────────────────────────────────────────

def load_entries(path: str):
    """Load all entries from a JSONL file. Skips blank lines, reports corrupt lines."""
    entries = []
    errors = []
    with open(path, "rb") as f:
        raw = f.read()
    # Try UTF-8, fall back to latin-1 if any byte sequences fail
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")

    for i, line in enumerate(text.split("\n"), 1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            entries.append(json.loads(stripped))
        except json.JSONDecodeError as e:
            errors.append((i, str(e), stripped[:200]))
    return entries, errors


def build_index(entries):
    """Build by_id index and find leaf (last entry)."""
    by_id = {}
    for e in entries:
        eid = e.get("id")
        if eid:
            by_id[eid] = e
    leaf = entries[-1] if entries else None
    return by_id, leaf


def active_branch(entries):
    """Return entries on the active leaf→root path."""
    if not entries:
        return []
    by_id, leaf = build_index(entries)
    path = []
    cur = leaf
    seen = set()
    while cur and cur.get("id") not in seen:
        seen.add(cur.get("id"))
        path.append(cur)
        cur = by_id.get(cur.get("parentId", ""))
    path.reverse()
    return path


def extract_text_blocks(content):
    """Extract all (type, text) pairs from a message content array."""
    blocks = []
    if not isinstance(content, list):
        return blocks
    for block in content:
        if not isinstance(block, dict):
            continue
        t = block.get("type", "unknown")
        if t == "text":
            blocks.append((t, block.get("text", "")))
        elif t == "thinking":
            blocks.append((t, block.get("thinking", "")))
        elif t == "toolCall":
            name = block.get("name", block.get("function", {}).get("name", "?"))
            args = block.get("arguments", block.get("function", {}).get("arguments", ""))
            if isinstance(args, dict):
                args = json.dumps(args)
            blocks.append((t, f"tool: {name}\nargs: {args[:500]}"))
        elif t == "toolResult":
            blocks.append((t, f"tool result: {str(block.get('content', ''))[:1000]}"))
        else:
            blocks.append((t, str(block)[:500]))
    return blocks


def entry_timestamp(e):
    """Return parsed timestamp or epoch."""
    ts = e.get("timestamp", "")
    if ts:
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            pass
    return datetime.fromtimestamp(0)


# ── Helpers ───────────────────────────────────────────────────────────────────

def parse_line_specs(raw_specs):
    """Parse line specs like '5', '5-10', '5-10 15 20-25' into sorted unique ints."""
    lines = set()
    for spec in raw_specs:
        if '-' in spec:
            try:
                a, b = spec.split('-', 1)
                start, end = int(a.strip()), int(b.strip())
                if start <= end:
                    lines.update(range(start, end + 1))
            except ValueError:
                continue
        else:
            try:
                lines.add(int(spec.strip()))
            except ValueError:
                continue
    return sorted(lines)


def _snippet_around(text, match_fn, context=1):
    """Return a snippet of text around the first line that match_fn returns truthy for."""
    lines = text.split('\n')
    for li, line in enumerate(lines):
        if match_fn(line):
            start = max(0, li - context)
            end = min(len(lines), li + context + 1)
            snippet = []
            for ci in range(start, end):
                prefix = '\u2192' if ci == li else ' '
                snippet.append(f'{prefix} {lines[ci][:300]}')
            return '\n'.join(snippet)
    return text[:200]


def _trunc(text, n=200):
    """Truncate text at n chars appending … if cut."""
    return text[:n] + ('...' if len(text) > n else '')


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_types(entries, style, limit=None, **_):
    """Summarize entry type distribution."""
    counter = Counter()
    for e in entries:
        counter[e.get("type", "unknown")] += 1
    total = sum(counter.values())
    print(f"{style.bold('Entry type distribution')}  ({total} total)\n")
    items = counter.most_common()
    if limit:
        items = items[:limit]
    for t, count in items:
        pct = count / total * 100
        bar = "█" * int(pct / 2)
        type_str = f"{t:30s}"
        count_str = f"{count:6d}"
        print(f"  {style.cyan(type_str)} {style.bold(count_str)}  ({pct:5.1f}%)  {bar}")


def cmd_orphans(entries, style, **_):
    """Find entries with missing parentId."""
    by_id, _ = build_index(entries)
    orphans = []
    for e in entries:
        pid = e.get("parentId")
        if pid and pid not in by_id:
            orphans.append((e.get("id"), pid, e.get("type")))
    if orphans:
        print(f"{style.bold(f'Found {len(orphans)} orphan entries')} (parentId missing)\n")
        for eid, pid, etype in orphans:
            eid_str = f"{eid:20s}"
        pid_str = f"{pid:20s}"
        print(f"  {style.red(eid_str)} ← parent {style.yellow(pid_str)}  ({etype})")
    else:
        print(f"{style.green('No orphan entries — all parentId references are valid')}")


def cmd_tree(entries, style, limit=None, **_):
    """Trace the active branch from leaf to root."""
    if not entries:
        print("(empty file)")
        return
    branch = active_branch(entries)
    by_id, leaf = build_index(entries)
    total = len(entries)
    print(f"{style.bold('Active branch')}  ({len(branch)} of {total} entries)")
    print(f"  Root: {style.green(branch[0].get('id', '?'))}" if branch else "")
    print(f"  Leaf: {style.yellow(leaf.get('id', '?'))}" if leaf else "")
    print()

    indent = "  "
    shown = 0
    for e in branch:
        if limit and shown >= limit:
            remaining = len(branch) - limit
            print(f"{style.dim(f'... {remaining} more entries not shown')}")
            break
        etype = e.get("type", "?")
        eid = e.get("id", "?")[:10]
        role = e.get("message", {}).get("role", "") if etype == "message" else ""
        label = f"{etype}"
        if role:
            label += f"/{role}"

        # Timestamp
        ts = e.get("timestamp", "")
        if ts:
            ts = ts[:19].replace("T", " ")

        # Text preview
        preview = ""
        if etype == "message":
            for t, text in extract_text_blocks(e.get("message", {}).get("content", [])):
                if t in ("text", "thinking"):
                    preview = text[:100].replace("\n", " ").strip()
                    if t == "thinking":
                        preview = f"[thinking] {preview}"
                    break

        pid = e.get("parentId", "")[:10] if e.get("parentId") else "(root)"

        eid_s = f"{eid:12s}"
        ts_s = f"{ts:20s}"
        label_s = f"{label:25s}"
        pid_s = f"{pid:12s}"
        print(f"  {style.blue(eid_s)} {style.dim(ts_s)} {style.cyan(label_s)} "
              f"← {style.dim(pid_s)} {preview}")
        shown += 1


def cmd_conversation(entries, style, max_text=300, limit=None, **_):
    """Print readable conversation transcript along the active branch."""
    branch = active_branch(entries)
    if not branch:
        print("(empty file)")
        return

    shown = 0
    for e in branch:
        if limit and shown >= limit:
            remaining = len(branch) - limit
            print(f"\n{style.dim(f'... {remaining} more entries not shown')}")
            break
        if e.get("type") != "message":
            continue
        shown += 1
        msg = e.get("message", {})
        role = msg.get("role", "?")
        ts = e.get("timestamp", "")
        if ts:
            ts = ts[:19].replace("T", " ")

        # Role color
        if role == "user":
            role_label = style.green(f" [{role}]")
        elif role == "assistant":
            role_label = style.blue(f"[{role}]")
        elif role == "toolResult":
            role_label = style.yellow(f"[{role}]")
        else:
            role_label = f"[{role}]"

        header = f"{style.dim(ts)} {role_label}"
        print(f"\n{header}")
        print(style.dim("\u2500" * min(60, len(header) + 4)))

        for t, text in extract_text_blocks(msg.get("content", [])):
            if t == "thinking":
                print(style.dim(f"  \U0001f4ad {text[:max_text]}"))
            elif t == "text":
                print(f"  {text[:max_text]}")
            elif t == "toolCall":
                print(style.cyan(f"  \U0001f527 {text[:max_text]}"))
            elif t == "toolResult":
                print(style.magenta(f"  \U0001f4ce {text[:max_text]}"))
    print()


def cmd_show(entries, style, line_nums=None, **_):
    """Pretty-print entries by line number. Accepts single, range (5-10), or list (5 8 12)."""
    if not line_nums:
        print("Usage: show <file> <lineNum> [lineNum...]  (e.g. 5, 5-10, 5 8 12, 5-10 15 20-25)")
        return

    def _print_entry(line_num):
        idx = line_num - 1
        if idx < 0 or idx >= len(entries):
            print(f"{style.yellow(f'Line {line_num} out of range (file has {len(entries)} entries)')}")
            return
        e = entries[idx]

        print(f"{style.header(' ENTRY ')}  line {line_num} of {len(entries)}")
        print(f"  {style.bold('type:')}      {e.get('type', '?')}")
        print(f"  {style.bold('id:')}        {e.get('id', '?')}")
        if e.get("parentId"):
            print(f"  {style.bold('parentId:')}  {e.get('parentId')}")
        if e.get("timestamp"):
            print(f"  {style.bold('timestamp:')} {e.get('timestamp')}")
        if e.get("message", {}).get("role"):
            print(f"  {style.bold('role:')}      {e['message']['role']}")

        # Extension-specific fields
        for key in ("provider", "modelId", "model", "toolName", "isError", "customType"):
            if key in e:
                val = e[key]
                if isinstance(val, str) and len(val) > 80:
                    val = val[:80] + "..."
                print(f"  {style.bold(f'{key}:')}    {val}")

        # Content blocks
        if e.get("type") == "message":
            blocks = extract_text_blocks(e.get("message", {}).get("content", []))
            if blocks:
                print(f"\n  {style.header(' CONTENT ')}")
                for t, text in blocks:
                    print(f"\n  {style.cyan(f'─── {t} ───')}")
                    lines = text.split("\n")
                    for line in lines[:100]:
                        print(f"  {line}")
                    if len(lines) > 100:
                        print(f"  {style.dim(f'... ({len(lines) - 100} more lines)')}")

        # Compaction summary
        if e.get("type") == "compaction" and e.get("summary"):
            summary = e["summary"]
            print(f"\n  {style.header(' COMPACTION SUMMARY ')}")
            if isinstance(summary, str):
                print(f"  {summary[:2000]}")
            else:
                print(f"  {json.dumps(summary, indent=2)[:2000]}")

        # Custom data
        if e.get("type") == "custom" and e.get("data"):
            data = e["data"]
            print(f"\n  {style.header(' CUSTOM DATA ')}")
            print(f"  {json.dumps(data, indent=2)[:2000]}")

    for line_num in line_nums:
        _print_entry(line_num)
        print()  # blank line between entries


def cmd_search(entries, style, query=None, queries=None, mode="text", limit=None,
               count_only=False, search_mode="single", literal=False, **_):
    """Search message text content only (not JSON metadata).

    Query modes:
      single <query>    - single query (default: regex; pass --literal for exact substring)
      --any <q> [q...]  - match if ANY of the queries appears as a literal substring
      --all <q> [q...]  - match if ALL of the queries appear as literal substrings

    Note: --any and --all treat their arguments as LITERAL substrings (no regex).
    This is intentional — they're the no-crafting-regex path. If you need
    regex, use single-query mode (which is regex by default) and pass
    `re.escape()`-style escaped patterns, or use --literal to opt out.

    Content modes:
      text   - search only user/assistant text (default)
      all    - search text + thinking + toolCalls + toolResults
      fields - search all JSON fields (like raw grep)

    Options:
      --limit N    cap results
      --count      just show match count
      --literal    (single-query mode) treat the query as an exact substring, not regex
    """
    if not query and not queries:
        print("Usage: search <file> <query> [--mode text|all|fields] [--limit N] [--count] [--literal]")
        print("       search <file> --any <q> [q...] [options]")
        print("       search <file> --all <q> [q...] [options]")
        print()
        print("  single-query: regex by default; --literal for exact substring")
        print("  --any / --all: each argument is a literal substring (no regex)")
        return

    # Build matcher
    if search_mode == "any" and queries:
        # --any: literal substrings (no regex)
        needles = [q.lower() for q in queries]
        def _match(text):
            t = text.lower()
            return any(n in t for n in needles)
        display_query = " | ".join(queries)
    elif search_mode == "all" and queries:
        # --all: literal substrings (no regex)
        needles = [q.lower() for q in queries]
        def _match(text):
            t = text.lower()
            return all(n in t for n in needles)
        display_query = " & ".join(queries)
    else:
        # single-query: regex by default; --literal for exact substring
        if literal:
            needle = query.lower()
            def _match(text):
                return needle in text.lower()
            display_query = f"(literal) {query}"
        else:
            pat = re.compile(query, re.IGNORECASE)
            def _match(text):
                return pat.search(text)
            display_query = query

    results = []

    for i, e in enumerate(entries):
        if e.get("type") != "message":
            if mode == "fields":
                raw = json.dumps(e)
                if _match(raw):
                    snippet = _snippet_around(raw, _match)
                    results.append((i + 1, e.get("type", "?"), e.get("id", ""),
                                    "", raw[:200], snippet))
            continue

        msg = e.get("message", {})
        role = msg.get("role", "?")
        ts = e.get("timestamp", "")[:19].replace("T", " ") if e.get("timestamp") else ""

        if mode == "fields":
            raw = json.dumps(e)
            if _match(raw):
                snippet = _snippet_around(raw, _match)
                results.append((i + 1, "message", e.get("id", ""), role, ts, snippet))
            continue

        blocks = extract_text_blocks(msg.get("content", []))
        for t, text in blocks:
            if mode == "text" and t not in ("text",):
                continue
            if _match(text):
                preview = _snippet_around(text, _match)
                results.append((i + 1, role, ts, t, preview, e.get("id", "")))
                break  # One result per entry to avoid duplicates

        if limit and len(results) >= limit:
            break

    if not results:
        print(f"No matches for {style.yellow(display_query)}")
        return

    if count_only:
        print(f"{style.bold(str(len(results)))} matches for {style.yellow(display_query)}")
        return

    print(f"{style.bold(f'{len(results)} matching entries')} for {style.yellow(display_query)}\n")
    shown = 0
    for r in results:
        if limit and shown >= limit:
            remaining = len(results) - limit
            print(f"\n{style.dim(f'... and {remaining} more (use --limit 0 to show all)')}")
            break
        if mode == "fields":
            line, etype, eid, role, ts, snippet = r
            line_s = f"line {line:5d}"
            ts_s = f"{ts:20s}" if ts else ""
            etype_s = f"{etype:15s}"
            print(f"  {style.blue(line_s)}  {style.dim(ts_s)}  {style.cyan(etype_s)}  {style.dim(eid)}")
            if snippet:
                for sl in snippet.split("\n"):
                    print(f"      {sl}")
        else:
            line, role, ts, block_type, preview, eid = r
            role_color = style.green(role) if role == "user" else style.blue(role)
            print(f"\n  {style.bold(f'line {line}')}  {style.dim(ts)}  [{role_color}]  ({block_type})")
            for pl in preview.split("\n"):
                print(f"  {pl}")
        shown += 1

def cmd_observations(entries, style, **_):
    """Extract observations and reflections from custom entries."""
    found = 0
    for e in entries:
        if e.get("type") != "custom":
            continue
        ctype = e.get("customType", "")
        if ctype not in ("om.observations.recorded", "om.reflections.recorded"):
            continue
        data = e.get("data", {})
        items = data.get("observations" if "observations" in data else "reflections", [])
        ts = e.get("timestamp", "")[:19].replace("T", " ") if e.get("timestamp") else ""

        label = "Observations" if "observations" in data else "Reflections"
        print(f"\n{style.header(f' {label} ({ctype}) ')}  {style.dim(ts)}")
        print(f"  Covers up to entry: {style.cyan(str(data.get('coversUpToId', '?')))}")
        print()

        for item in items:
            eid = item.get("id", "?")[:12]
            content = item.get("content", "")
            relevance = item.get("relevance", "")
            sources = item.get("supportingObservationIds", item.get("sourceEntryIds", []))
            tokens = item.get("tokenCount", "")

            parts = [f"  {style.blue(eid)}"]
            if relevance:
                color = {"high": style.red, "medium": style.yellow, "low": style.dim}.get(
                    relevance, style.dim)
                parts.append(color(f"[{relevance}]"))
            if tokens:
                parts.append(style.dim(f"({tokens} tokens)"))
            print(" ".join(parts))
            print(f"    {content[:300]}")
            if sources:
                print(f"    {style.dim(f'sources: {", ".join(sources)}')}")
            print()
            found += 1

    if found == 0:
        print("No observations or reflections found in this session file.")


def cmd_timeline(entries, style, limit=None, **_):
    """Chronological sequence of events."""
    sorted_entries = sorted(entries, key=entry_timestamp)
    print(f"{style.bold('Timeline')} ({len(sorted_entries)} entries)\n")
    shown = 0
    for e in sorted_entries:
        if limit and shown >= limit:
            remaining = len(sorted_entries) - limit
            print(f"{style.dim(f'... {remaining} more entries not shown')}")
            break
        shown += 1
        ts = e.get("timestamp", "")
        if ts:
            ts = ts[:19].replace("T", " ")
        etype = e.get("type", "?")
        eid = e.get("id", "?")[:10]
        pid = e.get("parentId", "")[:10] if e.get("parentId") else ""

        desc = ""
        if etype == "message":
            role = e.get("message", {}).get("role", "")
            for t, text in extract_text_blocks(e.get("message", {}).get("content", [])):
                if t == "text":
                    desc = text[:120].replace("\n", " ").strip()
                    break
                elif t == "thinking":
                    desc = f"[thinking] {text[:80].replace(chr(10), ' ').strip()}"
                    break
                elif t == "toolCall":
                    desc = f"[toolCall] {text[:80]}"
                    break
            if role:
                desc = f"[{role}] {desc}"
        elif etype == "compaction":
            desc = "[compaction]"
        elif etype == "model_change":
            desc = f"[model] {e.get('provider', '?')}/{e.get('modelId', '?')}"
        elif etype == "thinking_level_change":
            desc = f"[thinking] level {e.get('thinkingLevel', '?')}"
        elif etype == "session_info":
            desc = f"[session_info] {e.get('name', '?')}"
        elif etype == "custom":
            desc = f"[custom] {e.get('customType', '?')}"
        elif etype == "label":
            desc = f"[label] {e.get('label', '?')}"

        ts_s = f"{ts:20s}"
        etype_s = f"{etype:20s}"
        eid_s = f"{eid:12s}"
        pid_s = f"{pid:12s}"
        print(f"  {style.green(ts_s)} {style.blue(etype_s)} "
              f"{style.dim(eid_s)} ← {style.dim(pid_s)}  {desc}")


def cmd_export(entries, style, line_start=None, line_end=None, **_):
    """Export a range of lines as clean markdown."""
    if line_start is None:
        print("Usage: export <file> --lines N-M")
        return
    start = max(1, line_start)
    end = min(len(entries), line_end or line_start)

    for i in range(start - 1, end):
        e = entries[i]
        line_num = i + 1
        etype = e.get("type", "?")

        print(f"--- entry {line_num} | type: {etype}", end="")
        if etype == "message":
            role = e.get("message", {}).get("role", "")
            print(f" | role: {role}", end="")
        print(" ---")

        if etype == "message":
            for t, text in extract_text_blocks(e.get("message", {}).get("content", [])):
                if t == "thinking":
                    print(f"\n> 💭 {text}\n")
                elif t == "text":
                    print(text)
                elif t == "toolCall":
                    print(f"\n```toolcall\n{text}\n```\n")
                elif t == "toolResult":
                    print(f"\n```toolresult\n{text}\n```\n")
        elif etype == "compaction" and e.get("summary"):
            summary = e["summary"]
            if isinstance(summary, str):
                print(summary)
            else:
                print(json.dumps(summary, indent=2))
        else:
            # Generic dump for other types
            dumped = json.dumps(e, indent=2, default=str)
            # Truncate if huge
            if len(dumped) > 5000:
                print(dumped[:5000])
                print("...(truncated)")
            else:
                print(dumped)
        print()


# ── Main CLI ──────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    command = sys.argv[1]
    filepath = sys.argv[2]

    if not os.path.isfile(filepath):
        print(f"File not found: {filepath}", file=sys.stderr)
        sys.exit(1)

    # Parse global options
    no_color = "--no-color" in sys.argv
    quiet = "--quiet" in sys.argv

    # Detect if stdout is a terminal
    color_enabled = not no_color and sys.stdout.isatty()
    style = Style(color_enabled)

    # Load
    entries, errors = load_entries(filepath)
    if not quiet and errors:
        print(f"{style.yellow(f'Warning: {len(errors)} corrupt line(s)')}", file=sys.stderr)
        for line_num, err, preview in errors[:5]:
            print(f"  line {line_num}: {err}", file=sys.stderr)
            print(f"    preview: {preview}", file=sys.stderr)
        if len(errors) > 5:
            print(f"  ... and {len(errors) - 5} more", file=sys.stderr)
        print(file=sys.stderr)

    if not entries:
        print("No valid entries found.", file=sys.stderr)
        sys.exit(1)

    kwargs = {"style": style, "entries": entries, "quiet": quiet}

    # Helper: extract positional args before the first --option
    def _pos_args(start):
        """Return positional args from start up to first --option."""
        args = []
        for a in sys.argv[start:]:
            if a.startswith('--'):
                break
            args.append(a)
        return args

    # Helper: scan for --option value
    def _opt(name, default=None):
        for i, a in enumerate(sys.argv):
            if a == name and i + 1 < len(sys.argv):
                return sys.argv[i + 1]
        return default

    # Common options
    limit = _opt('--limit')
    if limit is not None:
        try:
            limit = int(limit)
            kwargs['limit'] = limit
        except ValueError:
            pass

    # Route commands
    if command == "types":
        cmd_types(**kwargs)

    elif command == "orphans":
        cmd_orphans(**kwargs)

    elif command == "tree":
        cmd_tree(**kwargs)

    elif command == "conversation":
        cmd_conversation(**kwargs)

    elif command == "show":
        specs = _pos_args(3)
        if not specs:
            print("Usage: show <file> <lineNum> [lineNum...]  (e.g. 5, 5-10, 5 8 12)")
            sys.exit(1)
        kwargs['line_nums'] = parse_line_specs(specs)
        cmd_show(**kwargs)

    elif command == "search":
        pos = _pos_args(3)
        mode = _opt('--mode', 'text')
        kwargs['mode'] = mode

        if '--literal' in sys.argv:
            kwargs['literal'] = True

        # Check for --any / --all
        any_idx = None
        all_idx = None
        for i, a in enumerate(sys.argv):
            if a == '--any':
                any_idx = i
                break
            elif a == '--all':
                all_idx = i
                break

        if any_idx is not None:
            kwargs['search_mode'] = 'any'
            # Collect args from after --any up to next --option
            qs = []
            for a in sys.argv[any_idx + 1:]:
                if a.startswith('--'):
                    break
                qs.append(a)
            kwargs['queries'] = qs
        elif all_idx is not None:
            kwargs['search_mode'] = 'all'
            qs = []
            for a in sys.argv[all_idx + 1:]:
                if a.startswith('--'):
                    break
                qs.append(a)
            kwargs['queries'] = qs
        else:
            kwargs['query'] = pos[0] if pos else None
            kwargs['search_mode'] = 'single'

        if '--count' in sys.argv:
            kwargs['count_only'] = True

        cmd_search(**kwargs)

    elif command == "observations":
        cmd_observations(**kwargs)

    elif command == "timeline":
        cmd_timeline(**kwargs)

    elif command == "export":
        lines_arg = _opt('--lines')
        if lines_arg and '-' in lines_arg:
            parts = lines_arg.split('-')
            kwargs["line_start"] = int(parts[0])
            kwargs["line_end"] = int(parts[1])
        elif lines_arg:
            kwargs["line_start"] = int(lines_arg)
            kwargs["line_end"] = int(lines_arg)
        cmd_export(**kwargs)

    else:
        print(f"Unknown command: {command}", file=sys.stderr)
        print(file=sys.stderr)
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
