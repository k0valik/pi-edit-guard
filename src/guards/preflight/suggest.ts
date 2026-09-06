import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = Array.from({ length: n + 1 }, () => 0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Max edit distance allowed for a basename to count as a near-match.
 *
 * Length-aware: the old max(2, ...) floor let ANY directory entry within
 * distance 2 of a 1-2 char query count as a "near match", flooding
 * suggestions with unrelated files. Tiny basenames now get proportionally
 * tiny budgets (exact-or-one-edit), while longer names keep the ~34% rule.
 */
function threshold(base: string): number {
  if (base.length <= 2) return base.length === 0 ? 0 : base.length - 1;
  return Math.max(1, Math.floor(base.length * 0.34));
}

export function nearMatches(value: string, cwd: string, max = 3): string[] {
  const resolved = resolve(cwd, value);
  const dir = dirname(resolved);
  if (!existsSync(dir)) return [];
  const target = basename(resolved).toLowerCase();
  const limit = threshold(target);

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const scored = entries
    .map((name) => ({ name, score: levenshtein(target, name.toLowerCase()) }))
    .filter((e) => e.score <= limit)
    .sort((a, b) => a.score - b.score)
    .slice(0, max);

  return scored.map((e) => relative(cwd, resolve(dir, e.name)).split("\\").join("/"));
}
