/**
 * Typed error hierarchy. Every provider maps its own errors onto these,
 * so users can write one `catch` block that works regardless of which
 * model/provider they're using.
 */

export class AntraError extends Error {
  /** Machine-readable error code, stable across SDK versions. */
  public readonly code: string;
  /** The provider that raised this error, e.g. "openai" | "anthropic". Undefined for SDK-level errors. */
  public readonly provider: string | undefined;
  /** Original error/response from the provider, for debugging. */
  public override readonly cause: unknown;

  constructor(message: string, opts: { code: string; provider?: string; cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    this.code = opts.code;
    this.provider = opts.provider;
    this.cause = opts.cause;
    // Maintains proper stack trace in V8 (Node/Chrome)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/** Invalid API key or auth failure. */
export class AuthError extends AntraError {
  constructor(message: string, opts: { provider?: string; cause?: unknown } = {}) {
    super(message, { code: "auth_error", ...opts });
  }
}

/** Rate limit hit. Carries `retryAfterMs` when the provider tells us how long to wait. */
export class RateLimitError extends AntraError {
  public readonly retryAfterMs: number | undefined;
  constructor(
    message: string,
    opts: { provider?: string; cause?: unknown; retryAfterMs?: number } = {}
  ) {
    super(message, { code: "rate_limit_error", ...opts });
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Request was malformed — bad params, invalid model name, etc. */
export class InvalidRequestError extends AntraError {
  constructor(message: string, opts: { provider?: string; cause?: unknown } = {}) {
    super(message, { code: "invalid_request_error", ...opts });
  }
}

/** Input exceeded the model's context window. */
export class ContextLengthError extends AntraError {
  constructor(message: string, opts: { provider?: string; cause?: unknown } = {}) {
    super(message, { code: "context_length_error", ...opts });
  }
}

/** Request took longer than the configured timeout. */
export class TimeoutError extends AntraError {
  constructor(message: string, opts: { provider?: string; cause?: unknown } = {}) {
    super(message, { code: "timeout_error", ...opts });
  }
}

/** Request was cancelled via AbortController. */
export class CancelledError extends AntraError {
  constructor(message: string, opts: { provider?: string; cause?: unknown } = {}) {
    super(message, { code: "cancelled_error", ...opts });
  }
}

/** Tool call arguments failed schema validation, or tool execution threw. */
export class ToolExecutionError extends AntraError {
  public readonly toolName: string;
  constructor(message: string, opts: { toolName: string; provider?: string; cause?: unknown }) {
    super(message, { code: "tool_execution_error", ...opts });
    this.toolName = opts.toolName;
  }
}

/** Catch-all for provider-side failures (5xx, malformed responses, etc). */
export class ProviderError extends AntraError {
  public readonly statusCode: number | undefined;
  constructor(
    message: string,
    opts: { provider?: string; cause?: unknown; statusCode?: number } = {}
  ) {
    super(message, { code: "provider_error", ...opts });
    this.statusCode = opts.statusCode;
  }
}

/** Type guard — useful for `if (isAntraError(e))` in user code. */
export function isAntraError(e: unknown): e is AntraError {
  return e instanceof AntraError;
}
