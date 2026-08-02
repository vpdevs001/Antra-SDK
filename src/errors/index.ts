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

/** A guardrail (input, output, or tool) rejected a value in "strict" mode. */
export class GuardrailError extends AntraError {
  /** Which kind of guardrail triggered this — useful for catch blocks that only care about one kind. */
  public readonly guardrailType: "input" | "output" | "tool";
  /** Name given at registration, if any. */
  public readonly guardrailName: string | undefined;
  constructor(
    message: string,
    opts: { guardrailType: "input" | "output" | "tool"; guardrailName?: string; cause?: unknown }
  ) {
    super(message, { code: "guardrail_error", cause: opts.cause });
    this.guardrailType = opts.guardrailType;
    this.guardrailName = opts.guardrailName;
  }
}

/**
 * A handoff couldn't proceed — either the requested handoff would exceed
 * `maxHandoffDepth` (loop prevention), or it targeted an agent that
 * wasn't registered via `AgentBuilder.handoffs([...])`. Always thrown,
 * never a soft/typed-result path — a runaway handoff chain is a
 * structural safety limit, not content a caller should be expected to
 * react to programmatically the way guardrail results are.
 */
export class HandoffError extends AntraError {
  public readonly fromAgent: string;
  public readonly toAgent: string;
  constructor(message: string, opts: { fromAgent: string; toAgent: string; cause?: unknown }) {
    super(message, { code: "handoff_error", cause: opts.cause });
    this.fromAgent = opts.fromAgent;
    this.toAgent = opts.toAgent;
  }
}

/**
 * A structured-output run (`agent.run(query, { outputSchema })`) never
 * produced valid output — either the model's response wasn't valid JSON,
 * or it didn't match the schema, and the repair loop ran out of attempts
 * (or the agent ran out of steps) before it succeeded.
 *
 * Thrown rather than returned, because `run()`'s typed return promises
 * a validated `output: z.infer<TSchema>` — silently returning without
 * one would violate that promise. This is the one place structured
 * output always throws, regardless of any guardrail `mode` setting.
 */
export class OutputValidationError extends AntraError {
  /** The raw (invalid) text the model produced on its last attempt. */
  public readonly rawOutput: string;
  /** How many repair attempts were made before giving up. */
  public readonly attempts: number;
  constructor(message: string, opts: { rawOutput: string; attempts: number; cause?: unknown }) {
    super(message, { code: "output_validation_error", cause: opts.cause });
    this.rawOutput = opts.rawOutput;
    this.attempts = opts.attempts;
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
