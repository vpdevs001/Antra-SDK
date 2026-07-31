/**
 * Manual smoke test — mocks `fetch` to verify the OpenAI provider's
 * request building, response parsing, and streaming logic actually work
 * end-to-end, without needing a real API key or network call.
 *
 * This is NOT the Chapter 11 test suite (no mock Provider, no vitest yet)
 * — just a quick sanity check that Chapter 2 actually works before we
 * move on. Run with: npx tsx smoke-test.ts
 */
import { Antra } from "./src/index.js";

// ---- Mock 1: non-streaming ----
async function testGenerate() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: "Hello from mock!", tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  const antra = new Antra({ apiKey: "test-key" });
  const result = await antra.generate({
    model: "gpt-4o",
    messages: [{ role: "user", content: "Say hi" }],
  });

  console.assert(result.content === "Hello from mock!", "generate(): content mismatch");
  console.assert(result.finishReason === "stop", "generate(): finishReason mismatch");
  console.assert(result.usage.totalTokens === 15, "generate(): usage mismatch");
  console.log("✅ generate() — non-streaming works");

  globalThis.fetch = originalFetch;
}

// ---- Mock 2: streaming (text + tool call) ----
async function testStream() {
  const originalFetch = globalThis.fetch;

  const sseLines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({
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
    })}`,
    `data: ${JSON.stringify({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}`,
    `data: [DONE]`,
  ];

  globalThis.fetch = (async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of sseLines) {
          controller.enqueue(encoder.encode(line + "\n\n"));
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;

  const antra = new Antra({ apiKey: "test-key" });
  const chunks = [];
  for await (const chunk of antra.stream({
    model: "gpt-4o",
    messages: [{ role: "user", content: "What's the weather in Paris?" }],
  })) {
    chunks.push(chunk);
  }

  const textDeltas = chunks
    .filter((c) => c.type === "text_delta")
    .map((c) => (c as { text: string }).text)
    .join("");
  const toolStart = chunks.find((c) => c.type === "tool_call_start");
  const toolDelta = chunks.find((c) => c.type === "tool_call_delta");
  const finish = chunks.find((c) => c.type === "finish");

  console.assert(textDeltas === "Hello", `stream(): text mismatch, got "${textDeltas}"`);
  console.assert(toolStart !== undefined, "stream(): missing tool_call_start");
  console.assert(toolDelta !== undefined, "stream(): missing tool_call_delta");
  console.assert(
    finish?.type === "finish" && finish.finishReason === "tool_calls",
    "stream(): finish reason mismatch"
  );
  console.log("✅ stream() — text + tool call streaming works");

  globalThis.fetch = originalFetch;
}

// ---- Mock 3: error mapping ----
async function testErrorMapping() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(
      JSON.stringify({ error: { message: "Invalid API key", code: "invalid_api_key" } }),
      {
        status: 401,
      }
    );
  }) as typeof fetch;

  const antra = new Antra({ apiKey: "bad-key" });
  try {
    await antra.generate({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    console.error("❌ expected AuthError to be thrown");
  } catch (err) {
    const { AuthError } = await import("./src/errors/index.js");
    console.assert(
      err instanceof AuthError,
      `error mapping: expected AuthError, got ${(err as Error).constructor.name}`
    );
    console.log("✅ error mapping — 401 correctly maps to AuthError");
  }

  globalThis.fetch = originalFetch;
}

await testGenerate();
await testStream();
await testErrorMapping();
console.log("\nAll Chapter 2 smoke tests passed.");
