import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Antra } from "../../src/client.js";
import { AuthError } from "../../src/errors/index.js";

function sseResponse(lines: object[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("OpenAIProvider", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("generate() parses a non-streaming completion correctly", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: "Hello!", tool_calls: undefined }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 }
      )) as typeof fetch;

    const client = new Antra({ apiKey: "test-key" });
    const result = await client.generate({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("Hello!");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("stream() yields text_delta and tool_call chunks, reassembling streamed JSON args", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        { choices: [{ delta: { content: "Hel" }, finish_reason: null }] },
        { choices: [{ delta: { content: "lo" }, finish_reason: null }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "get_weather", arguments: "" } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        },
      ])) as typeof fetch;

    const client = new Antra({ apiKey: "test-key" });
    const chunks = [];
    for await (const chunk of client.stream({
      model: "gpt-4o",
      messages: [{ role: "user", content: "weather?" }],
    })) {
      chunks.push(chunk);
    }

    const text = chunks
      .filter((c) => c.type === "text_delta")
      .map((c) => (c as { text: string }).text)
      .join("");
    expect(text).toBe("Hello");

    const toolDelta = chunks.find((c) => c.type === "tool_call_delta");
    expect(toolDelta).toMatchObject({ id: "call_1", argsDelta: '{"city":"Paris"}' });

    const finish = chunks.find((c) => c.type === "finish");
    expect(finish).toMatchObject({ finishReason: "tool_calls", usage: { totalTokens: 28 } });
  });

  it("maps a 401 response to AuthError", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { message: "Invalid API key", code: "invalid_api_key" } }),
        { status: 401 }
      )) as typeof fetch;

    const client = new Antra({ apiKey: "bad-key" });
    await expect(
      client.generate({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] })
    ).rejects.toThrow(AuthError);
  });
});
