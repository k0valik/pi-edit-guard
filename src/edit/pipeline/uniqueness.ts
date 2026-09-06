// Uniqueness guard: count occurrences of the ACTUAL matched text (not the
// query); more than one means the edit is ambiguous — fail, never guess.

import { findOccurrencePositions } from "../matching/chain.js";

export interface OccurrenceReport {
  count: number;
  /** 1-indexed line numbers of each occurrence. */
  positions: number[];
  ambiguous: boolean;
}

export function reportOccurrences(content: string, actual: string): OccurrenceReport {
  const positions = findOccurrencePositions(content, actual);
  return { count: positions.length, positions, ambiguous: positions.length > 1 };
}

/** e.g. [3, 7] → "line 3, line 7" */
export function formatLinePositions(positions: number[]): string {
  return positions.map((n) => `line ${n}`).join(", ");
}
