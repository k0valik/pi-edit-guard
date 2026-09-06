/**
 * String similarity primitives — LCS ratio and token-multiset coefficients.
 *
 * similarity() is the LCS ratio 2·LCS/(lenA+lenB) (mirrors OpenDev's
 * passes.rs). similarityUpperBound() is the O(1) length-ratio bound
 * 2·min/(lenA+lenB) used to skip the O(n·m) DP when it cannot clear a
 * threshold. TokenDice/Jaccard are order-insensitive complements over token
 * multisets, used by the token_overlap rescue pass and diagnostics.
 */

// LCS similarity ratio — operates on UTF-16 code units, mirroring OpenDev.

export function similarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;
  return (2.0 * lcsLength(a, b)) / (a.length + b.length);
}

/**
 * Cheapest possible upper bound on similarity(): LCS <= min(len) means
 * sim <= 2*min/(lenA+lenB). Callers with a known acceptance threshold can
 * skip the O(len^2) DP when this bound already fails it — rejecting via the
 * bound is EXACT (the true value can only be lower), so pruning never
 * changes match outcomes.
 */
export function similarityUpperBound(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;
  return (2.0 * Math.min(a.length, b.length)) / (a.length + b.length);
}

/** Longest common subsequence length (space-optimized DP). */
function lcsLength(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // UTF-16 code units — matches OpenDev's code-unit counting for the same data.
  let prev = Array.from({ length: n + 1 }, () => 0);
  let curr = Array.from({ length: n + 1 }, () => 0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(curr[j - 1], prev[j]);
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  return Math.max(...prev, 0);
}

// ---------------------------------------------------------------------------
// Token-multiset similarity — Sørensen-Dice / Jaccard
// ---------------------------------------------------------------------------
//
// Order-insensitive complements to the LCS ratio above: they measure whether
// two texts contain the same STUFF regardless of arrangement. Used by the
// token_overlap pass (rescue matching) and by closest-candidate diagnostics
// ("how much of my vocabulary survived in that region?").

/** Multiset token counts — identifiers, numbers, single punctuation chars. */
export function tokenCounts(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of s.match(/[A-Za-z_]\w*|\d+|[^\w\s]/g) ?? []) {
    m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

/** Sum over tokens of min(countA, countB). */
export function intersectSize(a: Map<string, number>, b: Map<string, number>): number {
  let n = 0;
  for (const [t, c] of a) {
    const bc = b.get(t);
    if (bc) n += Math.min(c, bc);
  }
  return n;
}

/** Sørensen-Dice coefficient over token multisets: 2|A∩B| / (|A|+|B|). */
export function tokenDice(a: string, b: string): number {
  const ca = tokenCounts(a);
  const cb = tokenCounts(b);
  let na = 0;
  for (const v of ca.values()) na += v;
  let nb = 0;
  for (const v of cb.values()) nb += v;
  if (na === 0 || nb === 0) return 0;
  return (2 * intersectSize(ca, cb)) / (na + nb);
}

/** Jaccard index over token multisets: |A∩B| / |A∪B|. */
export function tokenJaccard(a: string, b: string): number {
  const ca = tokenCounts(a);
  const cb = tokenCounts(b);
  let na = 0;
  let nb = 0;
  for (const v of ca.values()) na += v;
  for (const v of cb.values()) nb += v;
  const inter = intersectSize(ca, cb);
  const union = na + nb - inter;
  return union === 0 ? 0 : inter / union;
}
