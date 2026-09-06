/**
 * FNV-1a hash — 32-bit, non-cryptographic, deterministic.
 *
 * Used for fingerprinting config shapes / field sets where we need a
 * cheap, order-stable numeric identity. Not a security primitive.
 */

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

export function fastHash(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * FNV_PRIME) | 0;
  }
  return hash >>> 0;
}
