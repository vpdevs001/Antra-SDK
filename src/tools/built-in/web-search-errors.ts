import {
  AuthError,
  RateLimitError,
  InvalidRequestError,
  ProviderError,
} from "../../errors/index.js";

/**
 * Converts a failed Tavily HTTP response into the appropriate typed
 * AntraError. Reuses the same error hierarchy the model providers use
 * (Chapter 2/5) rather than inventing a separate error type for search
 * — a failing external API is a failing external API, whether it's
 * serving completions or search results.
 */
export async function mapTavilyError(response: Response): Promise<Error> {
  let body: { error?: string; detail?: string } = {};
  try {
    body = (await response.json()) as { error?: string; detail?: string };
  } catch {
    // Non-JSON error body — fall through with empty body.
  }

  const message =
    body.error ?? body.detail ?? response.statusText ?? "Tavily search request failed";

  if (response.status === 401 || response.status === 403) {
    return new AuthError(message, { provider: "tavily", cause: body });
  }
  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
    return new RateLimitError(message, {
      provider: "tavily",
      cause: body,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (response.status === 400 || response.status === 422) {
    return new InvalidRequestError(message, { provider: "tavily", cause: body });
  }

  return new ProviderError(message, {
    provider: "tavily",
    cause: body,
    statusCode: response.status,
  });
}
