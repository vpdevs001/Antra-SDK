import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Antra } from "../../src/client.js";
import { AuthError } from "../../src/errors/index.js";

function sseResponse(lines: object[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("AnthropicProvider", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("generate() sends `system` as a top-level field, never inside `messages`", async () => {
    let capturedBody: any;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Hi!" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const client = new Antra({ apiKey: "test-key", provider: "anthropic" });
    const result = await client.generate({
      model: "claude-3-5-sonnet-latest",
      system: "Be terse.",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(capturedBody.system).toBe("Be terse.");
    expect(capturedBody.messages.some((m: { role: string }) => m.role === "system")).toBe(false);
    expect(capturedBody.max_tokens).toBeTypeOf("number");
    expect(result.content).toBe("Hi!");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  });

  it("stream() reassembles tool_use args from input_json_delta fragments", async () => {
    globalThis.fetch = (async () =>
      sseResponse([
        { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 0 } } },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"city":' },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"Tokyo"}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
        { type: "message_stop" },
      ])) as typeof fetch;

    const client = new Antra({ apiKey: "test-key", provider: "anthropic" });
    const chunks = [];
    for await (const chunk of client.stream({
      model: "claude-3-5-sonnet-latest",
      messages: [{ role: "user", content: "weather?" }],
    })) {
      chunks.push(chunk);
    }

    const argsJoined = chunks
      .filter((c) => c.type === "tool_call_delta")
      .map((c) => (c as { argsDelta: string }).argsDelta)
      .join("");
    expect(argsJoined).toBe('{"city":"Tokyo"}');

    const finish = chunks.find((c) => c.type === "finish");
    expect(finish).toMatchObject({ finishReason: "tool_calls", usage: { totalTokens: 32 } });
  });

  it("maps a 401 response to AuthError", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "bad key" },
        }),
        { status: 401 }
      )) as typeof fetch;

    const client = new Antra({ apiKey: "bad-key", provider: "anthropic" });
    await expect(
      client.generate({
        model: "claude-3-5-sonnet-latest",
        messages: [{ role: "user", content: "hi" }],
      })
    ).rejects.toThrow(AuthError);
  });
});
