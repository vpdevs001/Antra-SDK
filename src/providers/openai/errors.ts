import {
  AuthError,
  RateLimitError,
  InvalidRequestError,
  ContextLengthError,
  ProviderError,
} from "../../errors/index.js";

interface OpenAIErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

/**
 * Converts a failed OpenAI HTTP response into the appropriate typed
 * AntraError. This is the single place OpenAI's specific error shapes
 * get translated — nowhere else in the SDK should know what an OpenAI
 * error looks like.
 */
export async function mapOpenAIError(response: Response): Promise<Error> {
  let body: OpenAIErrorBody = {};
  try {
    body = (await response.json()) as OpenAIErrorBody;
  } catch {
    // Response wasn't valid JSON (e.g. an HTML error page from a proxy/gateway) — fall through with empty body.
  }

  const message = body.error?.message ?? response.statusText ?? "OpenAI request failed";
  const code = body.error?.code;
  const type = body.error?.type;

  if (response.status === 401 || response.status === 403) {
    return new AuthError(message, { provider: "openai", cause: body });
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
    return new RateLimitError(message, {
      provider: "openai",
      cause: body,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  if (code === "context_length_exceeded" || type === "context_length_exceeded") {
    return new ContextLengthError(message, { provider: "openai", cause: body });
  }

  if (response.status === 400 || response.status === 404 || response.status === 422) {
    return new InvalidRequestError(message, { provider: "openai", cause: body });
  }

  return new ProviderError(message, {
    provider: "openai",
    cause: body,
    statusCode: response.status,
  });
}
