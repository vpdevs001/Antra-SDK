import {
  AuthError,
  RateLimitError,
  InvalidRequestError,
  ContextLengthError,
  ProviderError,
} from "../../errors/index.js";

interface AnthropicErrorBody {
  type?: string;
  error?: {
    type?: string;
    message?: string;
  };
}

/**
 * Converts a failed Anthropic HTTP response into the appropriate typed
 * AntraError. Anthropic's error shape differs from OpenAI's (nested
 * `error.type` string rather than a `code`, no dedicated
 * context-length error type — it shows up as an `invalid_request_error`
 * with a specific message), so this mapping is intentionally separate
 * from the OpenAI one rather than shared.
 */
export async function mapAnthropicError(response: Response): Promise<Error> {
  let body: AnthropicErrorBody = {};
  try {
    body = (await response.json()) as AnthropicErrorBody;
  } catch {
    // Non-JSON error body (e.g. an upstream gateway page) — fall through with empty body.
  }

  const message = body.error?.message ?? response.statusText ?? "Anthropic request failed";
  const errorType = body.error?.type;

  if (response.status === 401) {
    return new AuthError(message, { provider: "anthropic", cause: body });
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
    return new RateLimitError(message, {
      provider: "anthropic",
      cause: body,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  // Anthropic has no dedicated "context_length_exceeded" error type —
  // it's an invalid_request_error whose message says so. We detect it
  // heuristically so callers still get a specific, actionable error type.
  if (
    errorType === "invalid_request_error" &&
    /prompt is too long|maximum context length|too many tokens/i.test(message)
  ) {
    return new ContextLengthError(message, { provider: "anthropic", cause: body });
  }

  if (response.status === 400 || response.status === 404 || response.status === 422) {
    return new InvalidRequestError(message, { provider: "anthropic", cause: body });
  }

  // 529 = "overloaded_error", Anthropic-specific; treat as a retryable provider error.
  return new ProviderError(message, {
    provider: "anthropic",
    cause: body,
    statusCode: response.status,
  });
}
