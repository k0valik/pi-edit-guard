#!/usr/bin/env python3
"""
Session File Parsing — unified structured analysis of pi JSONL session files.

Usage:
  python3 session-file-parsing.py <command> <file> [options]

Commands:
  drill        Hierarchical drill-down with chainable filters
  search       Search using regex (default), --any (OR), or --all (AND)
  show         Show entries by single, range (5-10), or list (5 8 12 15-20)
  tree         Trace the active parent-child branch
  conversation Print readable conversation transcript
  observations Extract observations and reflections
  orphans      Find entries whose parentId is missing
  types        Summarize entry type distribution
  tool-calls   Histogram of tool calls + edit-op breakdown
  timeline     Chronological event sequence
  export       Export lines as clean markdown

Drill options (chainable — each narrows further):
  --type <t>            Filter entry type (message, custom, session, etc.)
  --role <r>            Filter message role (user, assistant, toolResult)
  --custom <ct>         Filter custom entries by customType
  --section <s>         Content section: text, thinking, toolCall, toolResult
  --keys                Show keys/fields visible at current filter level
  --show-data           Show full content (not just previews)
  --show-edits          Show edit tool arguments in detail
  --segment N-M         Extract line range N through M from matched content
  --limit N             Cap results
  --count               Just show count

Search options:
  --mode text|all|fields    Content scope (default: text)
  --any <q> [q...]          Match any of the queries (OR)
  --all <q> [q...]          Match all queries (AND)
  --limit N                 Cap results
  --count                   Show match count only

Tool-calls options:
  --list       Show every tool call chronologically
  --args       With --list, show argument keys and edit details
  --by-file    Show edit-tool op breakdown and batch-size distribution

Other commands accept --limit N for output capping.

Examples:
  # Broad overview
  python3 session-file-parsing.py drill session.jsonl

  # Drill into custom entries with their type breakdown
  python3 session-file-parsing.py drill session.jsonl --type custom

  # Drill into edit-guard events with data
  python3 session-file-parsing.py drill session.jsonl --type custom --custom edit-guard:event --show-data --limit 3

  # Drill into assistant thinking blocks
  python3 session-file-parsing.py drill session.jsonl --type message --role assistant --section thinking --limit 3

  # Show keys visible at current filter level
  python3 session-file-parsing.py drill session.jsonl --type message --role assistant --keys

  # Extract a specific segment from a thinking block
  python3 session-file-parsing.py drill session.jsonl --type message --role assistant --section thinking --segment 10-30 --limit 1

  # Count entries matching filter
  python3 session-file-parsing.py drill session.jsonl --type custom --custom pi-cache-turn --count

  # Count edit tool calls (field-mode search for tool name)
  python3 session-file-parsing.py search session.jsonl "\"name\": \"edit\"" --mode fields --count

  # Show entries with their content
  python3 session-file-parsing.py show session.jsonl 286
  python3 session-file-parsing.py show session.jsonl 285-290

  # Active branch tree
  python3 session-file-parsing.py tree session.jsonl

  # Chronological timeline
  python3 session-file-parsing.py timeline session.jsonl --limit 20

  # Tool call analysis
  python3 session-file-parsing.py tool-calls session.jsonl --list --args --limit 5
"""

import json
import sys
import os
from datetime import datetime
from collections import Counter, defaultdict
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
            args_obj = block.get("arguments", block.get("function", {}).get("arguments", ""))
            if isinstance(args_obj, dict):
                args_str = json.dumps(args_obj)
            else:
                args_str = str(args_obj)
            blocks.append((t, f"tool: {name}\nargs: {args_str}"))
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

BUILTIN_TOOLS = {"read", "write", "edit", "bash"}

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


# ── Existing Commands ─────────────────────────────────────────────────────────

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

        ts = e.get("timestamp", "")
        if ts:
            ts = ts[:19].replace("T", " ")

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
    """Pretty-print entries by line number."""
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

        for key in ("provider", "modelId", "model", "toolName", "isError", "customType"):
            if key in e:
                val = e[key]
                if isinstance(val, str) and len(val) > 80:
                    val = val[:80] + "..."
                print(f"  {style.bold(f'{key}:')}    {val}")

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

        if e.get("type") == "compaction" and e.get("summary"):
            summary = e["summary"]
            print(f"\n  {style.header(' COMPACTION SUMMARY ')}")
            if isinstance(summary, str):
                print(f"  {summary[:2000]}")
            else:
                print(f"  {json.dumps(summary, indent=2)[:2000]}")

        if e.get("type") == "custom" and e.get("data"):
            data = e["data"]
            print(f"\n  {style.header(' CUSTOM DATA ')}")
            print(f"  {json.dumps(data, indent=2)[:2000]}")

    for line_num in line_nums:
        _print_entry(line_num)
        print()


def cmd_search(entries, style, query=None, queries=None, mode="text", limit=None,
               count_only=False, search_mode="single", literal=False, **_):
    """Search message text content."""
    if not query and not queries:
        print("Usage: search <file> <query> [--mode text|all|fields] [--limit N] [--count] [--literal]")
        print("       search <file> --any <q> [q...] [options]")
        print("       search <file> --all <q> [q...] [options]")
        return

    if search_mode == "any" and queries:
        needles = [q.lower() for q in queries]
        def _match(text):
            t = text.lower()
            return any(n in t for n in needles)
        display_query = " | ".join(queries)
    elif search_mode == "all" and queries:
        needles = [q.lower() for q in queries]
        def _match(text):
            t = text.lower()
            return all(n in t for n in needles)
        display_query = " & ".join(queries)
    else:
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
                break

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
            dumped = json.dumps(e, indent=2, default=str)
            if len(dumped) > 5000:
                print(dumped[:5000])
                print("...(truncated)")
            else:
                print(dumped)
        print()


def cmd_tool_calls(entries, style, show_list=False, show_args=False, by_file=False, limit=None, **_):
    """Extract and analyze tool calls from the session.

    Separates builtin tools (read, write, edit, bash) from custom tools.
    """
    tool_calls = []
    tool_results = []
    for i, e in enumerate(entries, 1):
        if e.get("type") != "message":
            continue
        msg = e.get("message", {})
        content = msg.get("content")
        if isinstance(content, list):
            for c in content:
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "toolCall":
                    tool_calls.append((
                        c.get("name", "?"),
                        c.get("arguments", {}),
                        i,
                        e.get("timestamp", ""),
                    ))
        if msg.get("role") == "toolResult":
            tool_results.append((msg.get("toolName", "?"), msg.get("isError", False)))

    builtin_calls = [(n, a, l, t) for n, a, l, t in tool_calls if n in BUILTIN_TOOLS]
    custom_calls = [(n, a, l, t) for n, a, l, t in tool_calls if n not in BUILTIN_TOOLS]
    builtin_names = Counter(n for n, a, l, t in builtin_calls)
    custom_names = Counter(n for n, a, l, t in custom_calls)

    print(f"Total tool calls: {len(tool_calls)}"
          f"  (builtin: {style.cyan(str(sum(builtin_names.values())))}  custom: {style.magenta(str(sum(custom_names.values())))})")
    print(f"Total tool results: {len(tool_results)}")
    print()

    if builtin_names:
        print(f"{style.cyan('BUILTIN TOOL CALLS')} (read, write, edit, bash):")
        for name, n in builtin_names.most_common():
            print(f"  {n:4}  {name}")
        print()

    if custom_names:
        print(f"{style.magenta('CUSTOM TOOL CALLS')} (everything else):")
        for name, n in custom_names.most_common():
            print(f"  {n:4}  {name}")
        print()

    if tool_results:
        result_counts = Counter()
        error_counts = Counter()
        builtin_error_counts = Counter()
        custom_error_counts = Counter()
        for tn, is_err in tool_results:
            result_counts[tn] += 1
            if is_err:
                error_counts[tn] += 1
                if tn in BUILTIN_TOOLS:
                    builtin_error_counts[tn] += 1
                else:
                    custom_error_counts[tn] += 1
        print("Error rate by tool (errors / total results):")
        for name, total in result_counts.most_common():
            errs = error_counts.get(name, 0)
            label = f"{errs:4}/{total:4}  {name}"
            if name in BUILTIN_TOOLS:
                print(f"  {style.cyan(label)}")
            else:
                print(f"  {style.magenta(label)}")
        print()

    if by_file:
        edit_op_counts = Counter()
        edit_batch_sizes = []
        for name, args, _line_no, _ts in builtin_calls:
            if name != "edit":
                continue
            edits = args.get("edits", []) if isinstance(args, dict) else []
            if not isinstance(edits, list):
                continue
            edit_batch_sizes.append(len(edits))
            for ee in edits:
                if isinstance(ee, dict):
                    edit_op_counts[ee.get("op", "?")] += 1
        if edit_op_counts:
            print("Edit-tool op breakdown:")
            for op, n in edit_op_counts.most_common():
                print(f"  {n:4}  {op}")
            print()
        if edit_batch_sizes:
            from statistics import mean, median
            print(
                f"Edit batch sizes: count={len(edit_batch_sizes)} "
                f"mean={mean(edit_batch_sizes):.1f} "
                f"median={median(edit_batch_sizes):.0f} "
                f"max={max(edit_batch_sizes)}"
            )
            print()

    if show_list:
        print("All tool calls (chronological):")
        shown = 0
        for i, (name, args, line_no, ts) in enumerate(tool_calls, 1):
            if limit and shown >= limit:
                remaining = len(tool_calls) - limit
                print(f"{style.dim(f'... {remaining} more tool calls not shown')}")
                break
            shown += 1
            kind = style.cyan("builtin") if name in BUILTIN_TOOLS else style.magenta("custom")
            print(f"  [{i:3}] line={line_no:5} ts={ts}  {name}  ({kind})", end="")
            if show_args and isinstance(args, dict):
                keys = list(args.keys())
                print(f"  keys: {keys}")
                if "path" in args:
                    print(f"        path: {args['path']}")
                if "edits" in args and isinstance(args["edits"], list):
                    for j, edit in enumerate(args["edits"]):
                        if not isinstance(edit, dict):
                            continue
                        ek = list(edit.keys())
                        print(f"        edits[{j}] keys: {ek}")
                        if "op" in edit:
                            print(f"          op: {edit['op']}")
                        if "oldText" in edit:
                            old = edit["oldText"][:60].replace("\n", "\\n")
                            print(f"          oldText: {old!r}")
                        if "newText" in edit:
                            new = edit["newText"][:60].replace("\n", "\\n")
                            print(f"          newText: {new!r}")
                        if "range" in edit:
                            print(f"          range: {edit['range']}")
                        if "pos" in edit:
                            print(f"          pos: {edit['pos'][:50]!r}")
            else:
                print()

    return tool_calls, tool_results


# ═══════════════════════════════════════════════════════════════════════════════
# NEW: cmd_drill — Hierarchical drill-down
# ═══════════════════════════════════════════════════════════════════════════════

def cmd_drill(entries, style,
              filter_type=None,          # --type
              filter_role=None,          # --role
              filter_custom=None,        # --custom
              filter_section=None,       # --section (text|thinking|toolCall|toolResult)
              show_keys=False,           # --keys
              show_data=False,           # --show-data
              show_edits=False,          # --show-edits
              segment=None,              # --segment N-M
              limit=None,
              count_only=False,          # --count
              **_):
    """
    Hierarchical drill-down across entries and content sections.

    Each filter narrows the result set. Without filters, shows a broad summary
    of every accessible dimension (types, roles, custom types, content sections).
    """

    # ── Step 1: Filter by top-level entry type ──────────────────────────────
    filtered = entries
    if filter_type:
        filtered = [e for e in filtered if e.get("type") == filter_type]

    # ── Step 2: If message, filter by role ──────────────────────────────────
    if filter_role:
        filtered = [e for e in filtered
                     if e.get("type") == "message"
                     and e.get("message", {}).get("role") == filter_role]

    # ── Step 3: If custom, filter by customType ─────────────────────────────
    if filter_custom:
        filtered = [e for e in filtered
                     if e.get("type") == "custom"
                     and e.get("customType", "") == filter_custom]

    # ── Step 4: If --keys, show available keys ──────────────────────────────
    if show_keys:
        _drill_show_keys(filtered, style, filter_type, filter_role, filter_custom)
        return

    # ── Step 5: If count_only, just count ───────────────────────────────────
    if count_only:
        print(f"{style.bold(str(len(filtered)))} entries match current filter")
        return

    # ── Step 6: If no filters, show broad overview ─────────────────────────
    if not filter_type and not filter_role and not filter_custom and not filter_section and not show_edits:
        _drill_overview(entries, style, limit)
        return

    # ── Step 7: Apply section filter and display ───────────────────────────
    _drill_show_matches(filtered, style, filter_section, show_data, show_edits, segment, limit)


def _drill_overview(entries, style, limit):
    """Show a broad multi-dimensional summary — first step in any drill."""
    total = len(entries)

    # Entry type distribution
    type_counts = Counter(e.get("type", "unknown") for e in entries)
    print(f"{style.bold('ENTRY TYPE DISTRIBUTION')}  ({total} total)")
    for t, n in type_counts.most_common(limit or 20):
        pct = n / total * 100 if total else 0
        print(f"  {style.cyan(f'{t:32s}')} {style.bold(f'{n:6d}')}  ({pct:5.1f}%)")
    print()

    # Role distribution within messages
    msg_entries = [e for e in entries if e.get("type") == "message"]
    if msg_entries:
        role_counts = Counter(e.get("message", {}).get("role", "?") for e in msg_entries)
        print(f"{style.bold('MESSAGE ROLE DISTRIBUTION')}  ({len(msg_entries)} messages)")
        for r, n in role_counts.most_common():
            print(f"  {style.green(f'{r:32s}')} {n:6d}")
        print()

    # Custom type distribution
    custom_entries = [e for e in entries if e.get("type") == "custom"]
    if custom_entries:
        ct_counts = Counter(e.get("customType", "?") for e in custom_entries)
        print(f"{style.bold('CUSTOM ENTRY DISTRIBUTION')}  ({len(custom_entries)} custom)")
        for ct, n in ct_counts.most_common():
            print(f"  {style.yellow(f'{ct:42s}')} {n:6d}")
        print()

    # Content section types within messages
    section_counts = Counter()
    for e in msg_entries:
        content = e.get("message", {}).get("content", [])
        if isinstance(content, list):
            for c in content:
                if isinstance(c, dict):
                    section_counts[c.get("type", "unknown")] += 1
    if section_counts:
        print(f"{style.bold('CONTENT SECTION TYPES')}  (blocks within messages)")
        for st, n in section_counts.most_common():
            print(f"  {style.blue(f'{st:32s}')} {n:6d}")
        print()

    # Tool calls across all assistant messages — split builtin vs custom
    builtin_counts = Counter()
    custom_counts = Counter()
    for e in entries:
        if e.get("type") != "message":
            continue
        content = e.get("message", {}).get("content", [])
        if isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get("type") == "toolCall":
                    name = c.get("name", "?")
                    if name in BUILTIN_TOOLS:
                        builtin_counts[name] += 1
                    else:
                        custom_counts[name] += 1

    if builtin_counts or custom_counts:
        print(f"{style.bold('TOOL CALLS')}  (builtin: read, write, edit, bash | custom: everything else)")
        if builtin_counts:
            print(f"  {style.cyan('BUILTIN')}")
            for tn, n in builtin_counts.most_common():
                print(f"    {style.cyan(f'{tn:30s}')} {n:6d}")
        if custom_counts:
            print(f"  {style.magenta('CUSTOM')}")
            for tn, n in custom_counts.most_common():
                print(f"    {style.magenta(f'{tn:30s}')} {n:6d}")
        print()

    print(style.dim("┄" * 60))
    print(style.dim("Drill deeper: --type <type>  --role <role>  --custom <customType>  --section <section>"))
    print(style.dim("  Show keys: --keys  Show data: --show-data  Count: --count  Segment: --segment N-M"))


def _drill_show_keys(filtered, style, filter_type, filter_role, filter_custom):
    """Show the keys/fields visible at the current filter level."""
    if not filtered:
        print("No entries match current filter.")
        return

    # Collect top-level keys
    top_keys = Counter()
    msg_keys = Counter()
    data_keys = Counter()
    custom_type_set = set()

    for e in filtered:
        for k in e:
            if k != "message" and k != "data":
                top_keys[k] += 1
        if isinstance(e.get("message"), dict):
            for k in e["message"]:
                if k != "content":
                    msg_keys[k] += 1
        if isinstance(e.get("data"), dict):
            for k in e["data"]:
                data_keys[k] += 1
        if e.get("customType"):
            custom_type_set.add(e["customType"])

    print(f"{style.bold('TOP-LEVEL KEYS')}  ({len(filtered)} entries)")
    for k, n in top_keys.most_common():
        print(f"  {k:30s} {n:6d}")

    if msg_keys:
        print(f"\n{style.bold('MESSAGE KEYS')}")
        for k, n in msg_keys.most_common():
            print(f"  {k:30s} {n:6d}")

    if data_keys:
        print(f"\n{style.bold('DATA KEYS')}")
        for k, n in data_keys.most_common():
            print(f"  {k:30s} {n:6d}")

    if custom_type_set:
        print(f"\n{style.bold('CUSTOM TYPES')}")
        for ct in sorted(custom_type_set):
            print(f"  {ct}")

    print(f"\n{style.dim('Narrow further: specify --type, --role, --custom, --section filters')}")


def _drill_show_matches(filtered, style, filter_section, show_data, show_edits, segment, limit):
    """Show matched entries with content extraction."""
    if not filtered:
        print("No entries match current filter.")
        return

    shown = 0
    for idx, e in enumerate(filtered):
        if limit and shown >= limit:
            remaining = len(filtered) - limit
            print(f"\n{style.dim(f'... {remaining} more entries match (use --limit 0 to show all)')}")
            break

        etype = e.get("type", "?")
        eid = e.get("id", "?")[:12]
        ts = e.get("timestamp", "")[:19].replace("T", " ") if e.get("timestamp") else ""

        # Print entry header
        print(f"\n{style.header(f' {etype} ')}  {style.dim(ts)}  id={style.blue(eid)}", end="")

        if etype == "message":
            role = e.get("message", {}).get("role", "?")
            print(f"  role={style.green(role)}", end="")

            # Extract content blocks matching section filter
            msg = e.get("message", {})
            content = msg.get("content", [])
            if isinstance(content, list):
                for c in content:
                    if not isinstance(c, dict):
                        continue
                    bt = c.get("type", "?")
                    if filter_section and bt != filter_section:
                        continue

                    shown += 1
                    if bt == "text":
                        _print_text_block(c.get("text", ""), style, segment, show_data)
                    elif bt == "thinking":
                        _print_thinking_block(c.get("thinking", ""), style, segment, show_data)
                    elif bt == "toolCall":
                        _print_toolcall_block(c, style, show_data, show_edits)
                    elif bt == "toolResult":
                        _print_toolresult_block(c, style, show_data)
                    else:
                        print(f"\n  [{bt}] (unknown block type)")

        elif etype == "custom":
            ct = e.get("customType", "?")
            print(f"  type={style.yellow(ct)}")
            if show_data and e.get("data"):
                data = e["data"]
                print(f"  {json.dumps(data, indent=2, default=str)[:2000]}")
                if len(json.dumps(data)) > 2000:
                    print(f"  {style.dim('...(data truncated, use show <file> <line> for full)')}")
            elif e.get("data"):
                data = e["data"]
                # Show just the keys and first 80 chars of string values
                print(f"  data keys: {list(data.keys())}")
                for dk, dv in data.items():
                    if isinstance(dv, str) and len(dv) > 80:
                        print(f"    {dk}: {dv[:80]}...")
                    elif isinstance(dv, (int, float, bool)) or dv is None:
                        print(f"    {dk}: {dv}")
                    elif isinstance(dv, list):
                        print(f"    {dk}: list[{len(dv)}]")
                    elif isinstance(dv, dict):
                        print(f"    {dk}: dict keys={list(dv.keys())}")
            shown += 1

        elif etype in ("model_change", "thinking_level_change"):
            for k in ("provider", "modelId", "model", "thinkingLevel"):
                if k in e:
                    print(f"  {k}={e[k]}")
            shown += 1

        elif etype == "compaction" and e.get("summary"):
            summary = e["summary"]
            if isinstance(summary, str):
                print(f"  summary: {summary[:200]}")
            else:
                print(f"  summary: {json.dumps(summary, indent=2)[:500]}")
            shown += 1

        else:
            # Generic display
            dump = json.dumps(e, default=str)[:500]
            print(f"  {dump}")
            shown += 1

    if shown == 0:
        print("\nNo content sections matched the current filter.")
        print(style.dim("Try: --section text  --section thinking  --section toolCall  --section toolResult"))


def _print_text_block(text, style, segment, show_data):
    """Display a text block."""
    if segment:
        lines = text.split('\n')
        try:
            parts = segment.split('-')
            start = max(0, int(parts[0]) - 1)
            end = int(parts[1]) if len(parts) > 1 else len(lines)
            text = '\n'.join(lines[start:end])
        except (ValueError, IndexError):
            pass

    if show_data:
        print(f"\n  {style.header(' TEXT ')}")
        for line in text.split('\n')[:200]:
            print(f"  {line}")
        if len(text.split('\n')) > 200:
            print(f"  {style.dim('...(more lines)')}")
    else:
        preview = text[:300].replace('\n', '\n  ').strip()
        if preview:
            print(f"\n  {preview[:300]}")
            if len(text) > 300:
                print(f"  {style.dim('...(truncated)')}")


def _print_thinking_block(thinking, style, segment, show_data):
    """Display a thinking block."""
    lines = thinking.split('\n')

    if segment:
        try:
            parts = segment.split('-')
            start = max(0, int(parts[0]) - 1)
            end = int(parts[1]) if len(parts) > 1 else len(lines)
            lines = lines[start:end]
        except (ValueError, IndexError):
            pass

    if show_data:
        print(f"\n  {style.header(f' THINKING ({len(lines)} lines) ')}")
        for i, line in enumerate(lines, 1):
            print(f"  {i:4}  {line}")
    else:
        preview = '\n'.join(lines[:10])
        print(f"\n  {style.dim('💭 ')}{preview[:400]}", end="")
        if len(lines) > 10:
            print(f"\n  {style.dim(f'... ({len(lines)} total lines)')}")
        elif len(lines) == 0:
            print(f"\n  {style.dim('(empty thinking block)')}")
        print()


def _print_toolcall_block(block, style, show_data, show_edits):
    """Display a tool call block."""
    name = block.get("name", block.get("function", {}).get("name", "?"))
    args_obj = block.get("arguments", block.get("function", {}).get("arguments", {}))
    toolcall_id = block.get("id", block.get("toolCallId", ""))
    print(f"\n  {style.cyan(f'🛠  {name}')}", end="")
    if toolcall_id:
        print(f"  id={toolcall_id[:12]}")
    else:
        print()

    if show_data:
        if isinstance(args_obj, dict):
            print(f"  args: {json.dumps(args_obj, indent=2, default=str)[:1000]}")
        else:
            print(f"  args: {str(args_obj)[:500]}")

    if show_data and show_edits and name == "edit":
        if isinstance(args_obj, dict) and "edits" in args_obj:
            edits = args_obj["edits"]
            print(f"  edits[{len(edits)}]:")
            for j, edit in enumerate(edits):
                print(f"    [{j}] ", end="")
                if isinstance(edit, dict):
                    parts = []
                    if "op" in edit:
                        parts.append(f"op={edit['op']}")
                    if "oldText" in edit:
                        parts.append(f"oldText={edit['oldText'][:50]!r}...")
                    if "newText" in edit:
                        parts.append(f"newText={edit['newText'][:30]!r}...")
                    if "anchor" in edit:
                        parts.append(f"anchor={edit['anchor'][:30]!r}...")
                    if "range" in edit:
                        parts.append(f"range={edit['range']}")
                    print(", ".join(parts))
        if isinstance(args_obj, dict) and "path" in args_obj:
            print(f"   path: {args_obj['path']}")

    elif isinstance(args_obj, dict):
        keys = list(args_obj.keys())
        path = args_obj.get("path", "")
        edit_count = len(args_obj.get("edits", [])) if isinstance(args_obj.get("edits"), list) else 0
        print(f"   keys: {keys}  path={path}  edits={edit_count}")


def _print_toolresult_block(block, style, show_data):
    """Display a tool result block."""
    content = block.get("content", "")
    is_error = block.get("isError", False)
    tool_name = block.get("toolName", block.get("name", "?"))

    error_prefix = style.red("[ERROR]") if is_error else ""
    print(f"\n  {style.magenta('📎')} {tool_name}  {error_prefix}")

    if show_data:
        print(f"  {str(content)[:1000]}")
    else:
        preview = str(content)[:300].replace('\n', '\n  ')
        print(f"  {preview[:300]}")


# ═══════════════════════════════════════════════════════════════════════════════
# Main CLI
# ═══════════════════════════════════════════════════════════════════════════════

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

    # Helper: check for boolean flag
    def _flag(name):
        return name in sys.argv

    # Common options
    limit = _opt('--limit')
    if limit is not None:
        try:
            limit = int(limit)
            kwargs['limit'] = limit
        except ValueError:
            pass

    # ── Drill command ───────────────────────────────────────────────────
    if command == "drill":
        # Chainable drill-down filters
        kwargs['filter_type'] = _opt('--type')
        kwargs['filter_role'] = _opt('--role')
        kwargs['filter_custom'] = _opt('--custom')
        kwargs['filter_section'] = _opt('--section')
        kwargs['show_keys'] = _flag('--keys')
        kwargs['show_data'] = _flag('--show-data')
        kwargs['show_edits'] = _flag('--show-edits')
        kwargs['segment'] = _opt('--segment')
        kwargs['count_only'] = _flag('--count')
        cmd_drill(**kwargs)

    # ── Existing commands ───────────────────────────────────────────────
    elif command == "types":
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
        if _flag('--literal'):
            kwargs['literal'] = True

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

        if _flag('--count'):
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

    elif command == "tool-calls":
        if _flag('--list'):
            kwargs['show_list'] = True
        if _flag('--args'):
            kwargs['show_args'] = True
        if _flag('--by-file'):
            kwargs['by_file'] = True
        cmd_tool_calls(**kwargs)

    else:
        print(f"Unknown command: {command}", file=sys.stderr)
        print(file=sys.stderr)
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()