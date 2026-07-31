/**
 * Parses a Server-Sent Events stream into individual `data:` payloads,
 * JSON-parsed. Shared across providers since OpenAI, and most others,
 * all stream over SSE with the same basic framing — only the JSON
 * payload shape differs, which is handled by each provider's mapping.
 *
 * Yields `null` once it encounters the `[DONE]` sentinel some providers
 * (OpenAI) send to mark stream end; callers should stop iterating on `null`.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<unknown, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line in the buffer for next read.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice("data:".length).trim();
        if (data === "[DONE]") {
          return;
        }
        if (data === "") continue;

        try {
          yield JSON.parse(data);
        } catch {
          // Skip malformed chunks rather than killing the whole stream —
          // a single bad chunk shouldn't take down an otherwise-good response.
          continue;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
