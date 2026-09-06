// Shared LLM utilities for pi extensions.
//
// Provides retry logic and structured LLM call helpers for extensions
// that interact with AI models.

import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

// ── Retry with backoff ─────────────────────────────────────────────────────

/**
 * Options for withRetry.
 */
export interface WithRetryOptions {
  retries?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  logger?: (attempt: number, error: unknown) => void;
  onRetry?: (attempt: number, delayMs: number) => void;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Attempt an async operation with retries and exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: WithRetryOptions,
): Promise<T | null> {
  const { retries = 2, baseDelayMs = 1000, signal, logger, onRetry } = options ?? {};

  if (signal?.aborted) return null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      logger?.(attempt, err);
      if (attempt >= retries || signal?.aborted) continue;

      const delayMs = baseDelayMs * 2 ** attempt;
      onRetry?.(attempt, delayMs);

      try {
        await delay(delayMs, signal);
      } catch {
        return null;
      }
    }
  }

  return null;
}

// ── JSON extraction ────────────────────────────────────────────────────────

/**
 * Extract and validate JSON from LLM response content blocks.
 */
export function extractJsonFromResponse<T extends TSchema>(
  content: ReadonlyArray<{ type: string; text?: string }>,
  schema: T,
): { parsed: import("typebox").Static<T> } | null {
  const text = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (Value.Check(schema, parsed)) {
      return { parsed } as { parsed: import("typebox").Static<T> };
    }
    return null;
  } catch {
    return null;
  }
}

// ── callWithJsonResponse ───────────────────────────────────────────────────

export interface CallWithJsonResponseOptions {
  prompt: string;
  dataContext?: string;
  maxTokens?: number;
  systemPrompt?: string;
  retries?: number;
  logger?: (attempt: number, error: unknown) => void;
}

/**
 * Call the LLM with a prompt and validate the JSON response against a TypeBox schema.
 *
 * Handles model resolution, auth, retry via withRetry, text extraction,
 * JSON regex matching, and TypeBox validation.
 */
export async function callWithJsonResponse<T extends TSchema>(
  ctx: ExtensionContext,
  options: CallWithJsonResponseOptions,
  schema: T,
): Promise<{ parsed: import("typebox").Static<T> } | null> {
  const { prompt, dataContext, maxTokens = 4096, systemPrompt = "", retries = 2, logger } = options;

  const model = ctx.model ?? ctx.modelRegistry.getAvailable()[0] ?? null;
  if (!model) return null;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return null;

  const fullPrompt = dataContext ? `${prompt}\n\nDATA:\n${dataContext}` : prompt;

  const response = await withRetry(
    async () => {
      return complete(
        model,
        {
          systemPrompt,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: fullPrompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: ctx.signal,
          maxTokens,
        },
      );
    },
    { retries, baseDelayMs: 1000, signal: ctx.signal, logger },
  );

  if (!response) return null;

  const extracted = extractJsonFromResponse(response.content, schema);
  if (!extracted && logger) {
    const rawText = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    const contentSummary = response.content
      .map((c) => {
        if (c.type === "text") return `text(${c.text.slice(0, 80)}...)`;
        if (c.type === "thinking") return `thinking(${c.thinking?.slice(0, 80) || "empty"}...)`;
        return c.type;
      })
      .join(", ");
    logger(
      -1,
      `LLM response did not contain valid JSON matching schema. Content blocks: [${contentSummary}]. Raw text (first 500 chars): ${rawText.slice(0, 500)}`,
    );
  }
  return extracted;
}
