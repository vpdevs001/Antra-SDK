import { RateLimitError, ProviderError, TimeoutError } from "../errors/index.js";

export interface RetryConfig {
  /** Maximum attempts including the first — 3 means "try, retry, retry" (2 retries total). Default 3. */
  maxAttempts: number;
  /** Delay before the first retry, in ms. Doubles (× backoffMultiplier) each subsequent attempt. Default 500. */
  initialDelayMs: number;
  /** Ceiling on the computed delay, regardless of attempt count. Default 8000. */
  maxDelayMs: number;
  /** Multiplier applied to the delay after each attempt. Default 2. */
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 8000,
  backoffMultiplier: 2,
};

/** True for errors worth retrying — transient/provider-side, not a bad request that would fail identically every time. */
function isRetryableError(err: unknown): boolean {
  return (
    err instanceof RateLimitError || err instanceof ProviderError || err instanceof TimeoutError
  );
}

/**
 * Runs `fn`, retrying on transient errors with exponential backoff.
 * Respects `RateLimitError.retryAfterMs` when the provider tells us
 * exactly how long to wait, rather than guessing with a fixed backoff.
 * `onRetry` fires before each wait, so callers can log/trace the attempt.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  onRetry: (attempt: number, delayMs: number, error: unknown) => void
): Promise<{ result: T; retries: number }> {
  let attempt = 0;
  let delay = config.initialDelayMs;

  while (true) {
    try {
      const result = await fn();
      return { result, retries: attempt };
    } catch (err) {
      attempt++;
      if (attempt >= config.maxAttempts || !isRetryableError(err)) {
        throw err;
      }
      const waitMs =
        err instanceof RateLimitError && err.retryAfterMs !== undefined ? err.retryAfterMs : delay;
      onRetry(attempt, waitMs, err);
      await sleep(waitMs);
      delay = Math.min(delay * config.backoffMultiplier, config.maxDelayMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
