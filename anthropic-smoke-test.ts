/**
 * Smoke test for the Anthropic provider — verifies request building,
 * response parsing, and streaming logic against Anthropic's actual wire
 * format (separate `system` field, content blocks, `input_json_delta`
 * streaming for tool args) with a mocked fetch.
 */
import { Antra } from "./src/index.js";
import { AuthError } from "./src/errors/index.js";

async function testGenerate() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    // Verify system was sent as a top-level field, NOT inside messages (unlike OpenAI).
    console.assert(body.system === "You are terse.", "system field not sent correctly");
    console.assert(
      !body.messages.some((m: { role: string }) => m.role === "system"),
      "system leaked into messages array"
    );
    console.assert(
      typeof body.max_tokens === "number",
      "max_tokens missing (Anthropic requires it)"
    );

    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "Hello from Claude mock!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 6 },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const antra = new Antra({ apiKey: "test-key", provider: "anthropic" });
  const result = await antra.generate({
    model: "claude-3-5-sonnet-latest",
    system: "You are terse.",
    messages: [{ role: "user", content: "Say hi" }],
  });

  console.assert(result.content === "Hello from Claude mock!", "generate(): content mismatch");
  console.assert(result.finishReason === "stop", "generate(): finishReason mismatch");
  console.assert(result.usage.totalTokens === 18, "generate(): usage mismatch");
  console.log("✅ AnthropicProvider.generate() — system field + response parsing correct");

  globalThis.fetch = originalFetch;
}

async function testStreamWithToolCall() {
  const originalFetch = globalThis.fetch;

  const events = [
    { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " weather..." } },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"city":' },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '"Paris"}' },
    },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 15 } },
    { type: "message_stop" },
  ];

  globalThis.fetch = (async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) {
          controller.enqueue(encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  const antra = new Antra({ apiKey: "test-key", provider: "anthropic" });
  const chunks = [];
  for await (const chunk of antra.stream({
    model: "claude-3-5-sonnet-latest",
    messages: [{ role: "user", content: "Weather in Paris?" }],
  })) {
    chunks.push(chunk);
  }

  const text = chunks
    .filter((c) => c.type === "text_delta")
    .map((c) => (c as { text: string }).text)
    .join("");
  const toolStart = chunks.find((c) => c.type === "tool_call_start");
  const toolDeltas = chunks
    .filter((c) => c.type === "tool_call_delta")
    .map((c) => (c as { argsDelta: string }).argsDelta)
    .join("");
  const finish = chunks.find((c) => c.type === "finish");

  console.assert(text === "Checking weather...", `stream(): text mismatch, got "${text}"`);
  console.assert(
    toolStart !== undefined && (toolStart as { name: string }).name === "get_weather",
    "missing/wrong tool_call_start"
  );
  console.assert(
    toolDeltas === '{"city":"Paris"}',
    `stream(): tool args mismatch, got "${toolDeltas}"`
  );
  console.assert(
    finish?.type === "finish" && finish.finishReason === "tool_calls",
    "finish reason mismatch"
  );
  console.assert(
    finish?.type === "finish" && finish.usage.totalTokens === 35,
    "usage not accumulated correctly across message_start/message_delta"
  );
  console.log("✅ AnthropicProvider.stream() — text + incremental tool-call JSON assembly correct");

  globalThis.fetch = originalFetch;
}

async function testErrorMapping() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }),
      { status: 401 }
    );
  }) as typeof fetch;

  const antra = new Antra({ apiKey: "bad-key", provider: "anthropic" });
  try {
    await antra.generate({
      model: "claude-3-5-sonnet-latest",
      messages: [{ role: "user", content: "hi" }],
    });
    console.error("❌ expected AuthError to be thrown");
  } catch (err) {
    console.assert(
      err instanceof AuthError,
      `expected AuthError, got ${(err as Error).constructor.name}`
    );
    console.log("✅ AnthropicProvider — 401 correctly maps to AuthError");
  }

  globalThis.fetch = originalFetch;
}

await testGenerate();
await testStreamWithToolCall();
await testErrorMapping();
console.log("\nAll Anthropic provider smoke tests passed.");
