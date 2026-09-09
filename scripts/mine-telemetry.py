#!/usr/bin/env python3
"""Mine edit-guard telemetry from pi session JSONL files.

Reads edit-guard:event custom entries from pi session JSONL files and
aggregates statistics on match passes, repair rules, guards, and envelopes.

Usage:
    python3 scripts/mine-telemetry.py              # last 14 days, all scopes
    python3 scripts/mine-telemetry.py --days 30    # wider window
    python3 scripts/mine-telemetry.py --scope pi-better-toolcalls
    python3 scripts/mine-telemetry.py --json       # machine-readable output
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path

# --- Configuration (env-overridable, no hardcoded user paths) ---

def _sessions_dir() -> Path:
    """Resolve pi sessions directory from env or default location."""
    # PI_AGENT_DIR is the canonical env var pi uses
    agent = os.environ.get("PI_AGENT_DIR")
    if agent:
        return Path(agent) / "sessions"
    # Fallback: ~/.pi/agent/sessions (pi default)
    return Path.home() / ".pi" / "agent" / "sessions"


def _shorten_path(path: str, cwd: str | None = None) -> str:
    """Shorten an absolute path for display, preferring cwd-relative."""
    if not path:
        return path
    p = Path(path)
    # Try cwd-relative first
    if cwd:
        try:
            return str(p.relative_to(cwd))
        except ValueError:
            pass
    # Try home-relative
    home = Path.home()
    try:
        return "~/" + str(p.relative_to(home))
    except ValueError:
        pass
    # Try to strip any projects/ prefix as a last resort
    parts = p.parts
    for i, part in enumerate(parts):
        if part == "projects" and i + 1 < len(parts):
            return "/".join(parts[i:])
    return str(p)


# --- Session file iteration ---

def iter_session_files(
    cutoff_days: int = 14,
    scope_pattern: str | None = None,
    sessions_dir: Path | None = None,
):
    """Yield .jsonl session files newer than cutoff_days."""
    sdir = sessions_dir or _sessions_dir()
    if not sdir.is_dir():
        return
    cutoff = datetime.now(timezone.utc) - timedelta(days=cutoff_days)
    for scope_dir in sdir.iterdir():
        if not scope_dir.is_dir() or scope_dir.name.startswith("."):
            continue
        if scope_pattern and scope_pattern not in scope_dir.name:
            continue
        for f in scope_dir.glob("*.jsonl"):
            if f.name.endswith(".exit"):
                continue
            # Extract date from filename prefix (YYYY-MM-DDTHH-MM-SS...)
            try:
                ts_str = f.name.split("T")[0]
                file_date = datetime.strptime(ts_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                if file_date < cutoff:
                    continue
            except (ValueError, IndexError):
                continue
            yield f


# --- Telemetry parsing ---

def parse_telemetry_entries(filepath: Path) -> list[dict]:
    """Extract edit-guard:event batches from a session JSONL file."""
    entries = []
    try:
        with open(filepath, "r", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("customType") == "edit-guard:event":
                    data = obj.get("data", {})
                    events = data.get("events", [])
                    if events:
                        entries.append({
                            "timestamp": obj.get("timestamp"),
                            "events": events,
                        })
    except OSError:
        pass
    return entries


# --- Aggregation ---

def aggregate(all_entries: list[dict]) -> dict:
    """Aggregate telemetry counters across all batches."""
    stats = {
        "envelopes": 0,
        "edits_applied": 0,
        "edits_failed": 0,
        "edits_partial": 0,
        "repair_rules": 0,
        "autopatch": 0,
        "stormbreaker_enhanced": 0,
        "stormbreaker_loop_broken": 0,
        "stale_read_blocked": 0,
        "stale_read_self_healed": 0,
        "preflight_normalized": 0,
        "preflight_blocked": 0,
        "already_applied": 0,
        "anchor_not_found": 0,
        "anchor_ambiguous": 0,
        "anchor_redundant_dropped": 0,
        "auto_expand": 0,
        "overwrite_guard_blocked": 0,
        "write_guard_denied": 0,
        "path_advisory": 0,
    }
    passes: Counter[str] = Counter()
    repair_rules: Counter[str] = Counter()
    outcomes: Counter[str] = Counter()
    durations: list[float] = []
    closest_sims: list[float] = []
    files_edited: set[str] = set()
    file_counts: Counter[str] = Counter()
    corruption_warnings = 0
    coherence_warnings = 0
    post_write_warnings = 0
    semantic_warnings = 0

    for batch in all_entries:
        for ev in batch["events"]:
            t = ev.get("type")

            if t == "edit.envelope":
                stats["envelopes"] += 1
                outcomes[ev.get("outcome", "unknown")] += 1
                stats["edits_applied"] += ev.get("editsApplied", 0)
                path = ev.get("path", "")
                if path:
                    files_edited.add(path)
                    file_counts[path] += 1
                if ev.get("isPartial"):
                    stats["edits_partial"] += 1
                stats["edits_failed"] += ev.get("failedCount", 0)
                dur = ev.get("durationMs", 0)
                if dur > 0:
                    durations.append(dur)
                corruption_warnings += len(ev.get("corruptionWarnings", []))
                coherence_warnings += len(ev.get("coherenceWarnings", []))
                post_write_warnings += len(ev.get("postWriteWarnings", []))
                semantic_warnings += len(ev.get("semanticWarnings", []))
                cc = ev.get("closestCandidate")
                if cc:
                    closest_sims.append(cc["similarity"])

            elif t == "match.pass":
                passes[ev.get("passName", "unknown")] += 1
                if ev.get("autoExpand"):
                    stats["auto_expand"] += 1

            elif t == "edit.partial":
                stats["edits_partial"] += 1

            elif t == "repair.rule":
                stats["repair_rules"] += 1
                repair_rules[ev.get("ruleId", "unknown")] += 1

            elif t == "edit.autopatch":
                stats["autopatch"] += 1

            elif t == "stormbreaker.enhanced":
                stats["stormbreaker_enhanced"] += 1

            elif t == "stormbreaker.loop_broken":
                stats["stormbreaker_loop_broken"] += 1

            elif t == "stale_read.blocked":
                stats["stale_read_blocked"] += 1

            elif t == "stale_read.self_healed":
                stats["stale_read_self_healed"] += 1

            elif t == "preflight.normalized":
                stats["preflight_normalized"] += 1

            elif t == "preflight.blocked":
                stats["preflight_blocked"] += 1

            elif t == "match.already_applied":
                stats["already_applied"] += 1

            elif t == "anchor.not_found":
                stats["anchor_not_found"] += 1

            elif t == "anchor.ambiguous":
                stats["anchor_ambiguous"] += 1

            elif t == "anchor.redundant_dropped":
                stats["anchor_redundant_dropped"] += 1

            elif t == "overwrite_guard.blocked":
                stats["overwrite_guard_blocked"] += 1

            elif t == "write_guard.denied":
                stats["write_guard_denied"] += 1

            elif t == "path.advisory":
                stats["path_advisory"] += 1

    return {
        "stats": stats,
        "passes": passes,
        "repair_rules": repair_rules,
        "outcomes": outcomes,
        "durations": durations,
        "closest_sims": closest_sims,
        "files_edited": files_edited,
        "file_counts": file_counts,
        "warnings": {
            "corruption": corruption_warnings,
            "coherence": coherence_warnings,
            "post_write": post_write_warnings,
            "semantic": semantic_warnings,
        },
    }


# --- Output ---

def _fmt_duration(durations: list[float]) -> dict:
    if not durations:
        return {}
    ds = sorted(durations)
    n = len(ds)
    return {
        "mean": round(sum(ds) / n, 1),
        "median": round(ds[n // 2], 1),
        "p95": round(ds[int(n * 0.95)], 1),
        "min": round(ds[0], 1),
        "max": round(ds[-1], 1),
    }


def print_text_report(result: dict, scanned: int, with_telemetry: int, days: int, cwd: str | None):
    st = result["stats"]
    pc = result["passes"]
    rc = result["repair_rules"]
    oc = result["outcomes"]
    dur = result["durations"]
    sims = result["closest_sims"]
    w = result["warnings"]
    total = sum(pc.values())
    simple = pc.get("simple", 0)
    fuzzy = total - simple

    print(f"{'=' * 60}")
    print(f"  EDIT-GUARD TELEMETRY REPORT")
    print(f"  Period: last {days} days | Sessions scanned: {scanned}")
    print(f"  Sessions with telemetry: {with_telemetry}")
    print(f"{'=' * 60}")

    print(f"\n--- EDIT CALLS ---")
    print(f"  Total envelopes emitted:      {st['envelopes']}")
    print(f"  Outcomes:")
    for name, count in oc.most_common():
        print(f"    {name:20s}  {count}")
    print(f"  Total individual edits applied: {st['edits_applied']}")
    print(f"  Total edits failed:            {st['edits_failed']}")
    print(f"  Total partial applies:         {st['edits_partial']}")
    print(f"  Files edited (unique):         {len(result['files_edited'])}")

    dd = _fmt_duration(dur)
    if dd:
        print(f"\n  Edit duration (ms):")
        print(f"    Mean:   {dd['mean']}")
        print(f"    Median: {dd['median']}")
        print(f"    P95:    {dd['p95']}")
        print(f"    Min:    {dd['min']}")
        print(f"    Max:    {dd['max']}")

    print(f"\n--- MATCH PASSES ---")
    for pname, cnt in pc.most_common():
        print(f"  {pname:30s}  {cnt:5d}")

    print(f"\n--- FUZZY MATCHING SAVES ---")
    if total > 0:
        print(f"  Exact (simple) matches:         {simple:5d}  ({simple / total * 100:.1f}%)")
        print(f"  Fuzzy matches (saved edits):    {fuzzy:5d}  ({fuzzy / total * 100:.1f}%)")
    fuzzy_only = {k: v for k, v in pc.items() if k != "simple"}
    if fuzzy_only:
        print(f"  Fuzzy match breakdown:")
        for pname, cnt in sorted(fuzzy_only.items(), key=lambda x: -x[1]):
            print(f"    {pname:28s}  {cnt:5d}")
    print(f"  Auto-expand (context growth):   {st['auto_expand']}")
    print(f"  Already-applied detected:       {st['already_applied']}")

    print(f"\n--- ANCHOR SYSTEM ---")
    print(f"  Anchor not found:              {st['anchor_not_found']}")
    print(f"  Anchor ambiguous:              {st['anchor_ambiguous']}")
    print(f"  Anchor redundant (dropped):    {st['anchor_redundant_dropped']}")

    if sims:
        print(f"\n--- CLOSEST CANDIDATE (near-miss diagnostics) ---")
        print(f"  Times shown:                   {len(sims)}")
        print(f"  Mean similarity:               {sum(sims) / len(sims):.3f}")

    print(f"\n--- REPAIR PIPELINE ---")
    print(f"  Repair rules fired:            {st['repair_rules']}")
    for rid, cnt in rc.most_common():
        print(f"    {rid:30s}  {cnt:5d}")
    print(f"  Autopatch corrections:         {st['autopatch']}")

    print(f"\n--- GUARDS ---")
    print(f"  Preflight normalized:          {st['preflight_normalized']}")
    print(f"  Preflight blocked:             {st['preflight_blocked']}")
    print(f"  Stale-read blocked:            {st['stale_read_blocked']}")
    print(f"  Stale-read self-healed:        {st['stale_read_self_healed']}")
    print(f"  Stormbreaker enhanced:         {st['stormbreaker_enhanced']}")
    print(f"  Stormbreaker loop broken:      {st['stormbreaker_loop_broken']}")
    print(f"  Overwrite guard blocked:       {st['overwrite_guard_blocked']}")
    print(f"  Write guard denied:            {st['write_guard_denied']}")
    print(f"  Path advisories:               {st['path_advisory']}")

    print(f"\n--- WARNINGS (advisory, never blocking) ---")
    print(f"  Corruption:                    {w['corruption']}")
    print(f"  Coherence:                     {w['coherence']}")
    print(f"  Post-write:                    {w['post_write']}")
    print(f"  Semantic:                      {w['semantic']}")

    print(f"\n--- TOP 20 MOST-EDITED FILES ---")
    for fpath, cnt in result["file_counts"].most_common(20):
        print(f"  {cnt:4d}  {_shorten_path(fpath, cwd)}")

    if total > 0:
        print(f"\n{'=' * 60}")
        print(f"  KEY METRIC: {fuzzy} of {total} edits ({fuzzy / total * 100:.1f}%)")
        print(f"  resolved via fuzzy matching (would have failed with exact-only)")
        print(f"{'=' * 60}")

    # Fuzzy detail list
    print(f"\n--- FUZZY MATCH DETAILS ---")
    details = []
    for batch in all_entries:
        for ev in batch["events"]:
            if ev.get("type") == "edit.envelope":
                pns = ev.get("passNames", [])
                if any(pn != "simple" for pn in pns):
                    details.append(ev)
    for i, env in enumerate(details, 1):
        outcome = env.get("outcome", "?")
        pns = env.get("passNames", [])
        applied = env.get("editsApplied", 0)
        dur_ms = env.get("durationMs", 0)
        print(f"  {i:2d}. [{outcome:8s}] {_shorten_path(env.get('path', '?'), cwd)}")
        print(f"      passes: {', '.join(pns)} | edits: {applied} | {dur_ms:.0f}ms")
        cc = env.get("closestCandidate")
        if cc:
            print(f"      closest candidate: similarity={cc['similarity']:.3f}")
        for rr in env.get("repairRules", []):
            print(f"      repair: {rr['ruleId']} -> {rr['outcome']}")


def output_json(result: dict, scanned: int, with_telemetry: int, days: int):
    """Machine-readable JSON output."""
    st = result["stats"]
    pc = result["passes"]
    total = sum(pc.values())
    simple = pc.get("simple", 0)
    fuzzy = total - simple
    out = {
        "period_days": days,
        "sessions_scanned": scanned,
        "sessions_with_telemetry": with_telemetry,
        **st,
        "pass_breakdown": dict(pc.most_common()),
        "repair_rule_breakdown": dict(result["repair_rules"].most_common()),
        "outcome_breakdown": dict(result["outcomes"].most_common()),
        "duration_stats": _fmt_duration(result["durations"]),
        "closest_candidate_mean_similarity": (
            round(sum(result["closest_sims"]) / len(result["closest_sims"]), 3)
            if result["closest_sims"] else None
        ),
        "warnings": result["warnings"],
        "fuzzy_saves": fuzzy,
        "fuzzy_pct": round(fuzzy / total * 100, 1) if total else 0,
    }
    print(json.dumps(out, indent=2))


# --- Main ---

def main():
    import argparse

    parser = argparse.ArgumentParser(
        description="Mine edit-guard telemetry from pi session JSONL files."
    )
    parser.add_argument(
        "--days", type=int, default=14,
        help="Lookback period in days (default: 14)"
    )
    parser.add_argument(
        "--scope", type=str, default=None,
        help="Substring filter on scope directory name"
    )
    parser.add_argument(
        "--sessions-dir", type=str, default=None,
        help="Override sessions directory (default: $PI_AGENT_DIR/sessions or ~/.pi/agent/sessions)"
    )
    parser.add_argument(
        "--json", dest="json_output", action="store_true",
        help="Output machine-readable JSON instead of text report"
    )
    args = parser.parse_args()

    sessions_dir = Path(args.sessions_dir) if args.sessions_dir else None
    cwd = os.environ.get("PWD")

    all_entries: list[dict] = []
    scanned = 0
    with_telemetry = 0

    for fpath in iter_session_files(args.days, args.scope, sessions_dir):
        scanned += 1
        entries = parse_telemetry_entries(fpath)
        if entries:
            with_telemetry += 1
            all_entries.extend(entries)

    if not all_entries:
        if args.json_output:
            print(json.dumps({"sessions_scanned": scanned, "sessions_with_telemetry": 0, "envelopes": 0}))
        else:
            print("No telemetry entries found.")
        sys.exit(0)

    result = aggregate(all_entries)

    if args.json_output:
        output_json(result, scanned, with_telemetry, args.days)
    else:
        print_text_report(result, scanned, with_telemetry, args.days, cwd)


if __name__ == "__main__":
    main()
