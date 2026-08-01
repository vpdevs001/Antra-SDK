import type { Provider, ProviderCapabilities } from "../core/provider.js";
import type { GenerateOptions, GenerateResult, StreamChunk } from "../core/types.js";
import {
  RateLimitError,
  ProviderError,
  TimeoutError,
  InvalidRequestError,
} from "../errors/index.js";

export interface FallbackEntry {
  provider: Provider;
  /**
   * Model ID to use when falling back to this provider, since model
   * names differ across providers (e.g. "gpt-4o" vs
   * "claude-3-5-sonnet-latest"). If omitted, the model from the original
   * call is passed through unchanged — fine when it happens to be valid
   * for this provider too, but usually you'll want to set this explicitly.
   */
  model?: string;
}

/**
 * Wraps multiple providers as one, trying each in order until one
 * succeeds. Implements the same Provider interface as any single
 * provider, so it's a drop-in replacement anywhere a Provider is
 * expected — including as the provider behind an Antra client.
 *
 * Only retries on failures that are plausibly transient/provider-side
 * (rate limits, timeouts, 5xx-class provider errors). Errors that
 * indicate a genuinely bad request (InvalidRequestError, AuthError,
 * ContextLengthError) are NOT retried against a fallback — the same
 * bad request would just fail the same way on the next provider too,
 * and retrying would hide the real problem.
 */
export class FallbackProvider implements Provider {
  readonly name = "fallback";
  readonly capabilities: ProviderCapabilities;
  private readonly entries: FallbackEntry[];

  constructor(entries: FallbackEntry[]) {
    if (entries.length === 0) {
      throw new InvalidRequestError("FallbackProvider requires at least one provider entry.");
    }
    this.entries = entries;
    // Conservative: only claim a capability if every provider in the chain supports it,
    // since a caller relying on a capability needs it to hold no matter which one is actually used.
    this.capabilities = {
      supportsParallelToolCalls: entries.every(
        (e) => e.provider.capabilities.supportsParallelToolCalls
      ),
      supportsVision: entries.every((e) => e.provider.capabilities.supportsVision),
      supportsStreaming: entries.every((e) => e.provider.capabilities.supportsStreaming),
    };
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    let lastError: unknown;

    for (const entry of this.entries) {
      try {
        return await entry.provider.generate(this.applyModel(options, entry));
      } catch (err) {
        if (!isRetryable(err)) throw err;
        lastError = err;
      }
    }

    throw lastError;
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, unknown> {
    let lastError: unknown;

    for (const entry of this.entries) {
      let yieldedAny = false;
      try {
        for await (const chunk of entry.provider.stream(this.applyModel(options, entry))) {
          yieldedAny = true;
          yield chunk;
        }
        return;
      } catch (err) {
        // Once we've streamed real content to the caller, we can't safely
        // retry — they've already seen partial output from this attempt,
        // and a fallback would either duplicate it or produce a
        // discontinuous response. So we only fall back on a clean,
        // pre-first-chunk failure.
        if (yieldedAny || !isRetryable(err)) throw err;
        lastError = err;
      }
    }

    throw lastError;
  }

  private applyModel(options: GenerateOptions, entry: FallbackEntry): GenerateOptions {
    return entry.model ? { ...options, model: entry.model } : options;
  }
}

function isRetryable(err: unknown): boolean {
  return (
    err instanceof RateLimitError || err instanceof ProviderError || err instanceof TimeoutError
  );
}
