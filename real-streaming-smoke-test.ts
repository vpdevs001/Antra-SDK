/**
 * Smoke test for real token-level streaming in the agent loop.
 * Covers: text_delta events actually fire incrementally when eligible
 * (no output guardrails, no outputSchema), the loop correctly falls
 * back to buffered generate() when either is configured (verified via
 * the actual request body's `stream` flag, not just behavior), and a
 * tool call whose arguments arrive as streamed JSON fragments still
 * executes correctly end-to-end.
 */
import { z } from "zod";
import { Antra, Agent, defineTool } from "./src/index.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

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

const client = new Antra({ apiKey: "test-key" });

// --- 1. Eligible (no guardrails, no schema): real text_delta events fire, request actually used stream:true ---
async function testRealStreamingWhenEligible() {
  const originalFetch = globalThis.fetch;
  let capturedStreamFlag: boolean | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    capturedStreamFlag = JSON.parse(init.body as string).stream;
    return sseResponse([
      { choices: [{ delta: { content: "Hel" }, finish_reason: null }] },
      { choices: [{ delta: { content: "lo " }, finish_reason: null }] },
      { choices: [{ delta: { content: "world!" }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    ]);
  }) as typeof fetch;

  const textDeltas: string[] = [];
  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Assistant.")
    .onEvent((e) => {
      if (e.type === "text_delta") textDeltas.push(e.text);
    })
    .build();

  const result = await agent.run("Say hello world.", { streamText: true });

  assert(
    capturedStreamFlag === true,
    "expected the request to use stream:true when no guardrails/schema are configured"
  );
  assert(
    textDeltas.length === 3,
    `expected 3 separate text_delta events, got ${textDeltas.length}`
  );
  assert(
    textDeltas.join("") === "Hello world!",
    `text_delta events didn't reconstruct to the full content, got "${textDeltas.join("")}"`
  );
  assert(result.content === "Hello world!", `final result content wrong: "${result.content}"`);
  console.log(
    "✅ Real streaming — text_delta fires incrementally when eligible, request used stream:true"
  );

  globalThis.fetch = originalFetch;
}

// --- 2. Output guardrail configured: falls back to buffered generate(), no text_delta events ---
async function testFallsBackWithOutputGuardrail() {
  const originalFetch = globalThis.fetch;
  let capturedStreamFlag: boolean | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    capturedStreamFlag = JSON.parse(init.body as string).stream;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Safe response." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const textDeltas: string[] = [];
  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Assistant.")
    .outputGuardrail(() => ({ passed: true }), { mode: "soft" })
    .onEvent((e) => {
      if (e.type === "text_delta") textDeltas.push(e.text);
    })
    .build();

  const result = await agent.run("Say something.", { streamText: true });

  assert(
    capturedStreamFlag === false,
    "expected stream:false — an output guardrail is configured, must buffer for validation"
  );
  assert(
    textDeltas.length === 0,
    `expected zero text_delta events when an output guardrail is present, got ${textDeltas.length}`
  );
  assert(result.content === "Safe response.", `unexpected content: "${result.content}"`);
  console.log(
    "✅ Real streaming — correctly falls back to buffered generate() when an output guardrail is configured"
  );

  globalThis.fetch = originalFetch;
}

// --- 3. outputSchema configured: falls back too, no text_delta events ---
async function testFallsBackWithOutputSchema() {
  const originalFetch = globalThis.fetch;
  let capturedStreamFlag: boolean | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    capturedStreamFlag = JSON.parse(init.body as string).stream;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"name":"Ada"}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const textDeltas: string[] = [];
  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Assistant.")
    .onEvent((e) => {
      if (e.type === "text_delta") textDeltas.push(e.text);
    })
    .build();

  const result = await agent.run("Extract the name.", {
    outputSchema: z.object({ name: z.string() }),
    streamText: true,
  });

  assert(
    capturedStreamFlag === false,
    "expected stream:false — an outputSchema is configured for this call, must buffer to validate"
  );
  assert(
    textDeltas.length === 0,
    `expected zero text_delta events when outputSchema is set, got ${textDeltas.length}`
  );
  assert(result.output.name === "Ada", `unexpected output: ${JSON.stringify(result.output)}`);
  console.log(
    "✅ Real streaming — correctly falls back to buffered generate() when outputSchema is set for this call"
  );

  globalThis.fetch = originalFetch;
}

// --- 4. A tool call whose args arrive as streamed JSON fragments still executes correctly ---
async function testStreamedToolCallExecutesCorrectly() {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    if (callCount === 1) {
      return sseResponse([
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
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '"Tokyo"}' } }] },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ]);
    }
    return sseResponse([
      { choices: [{ delta: { content: "It's sunny in Tokyo." }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ]);
  }) as typeof fetch;

  const getWeather = defineTool({
    name: "get_weather",
    description: "Get weather for a city",
    schema: z.object({ city: z.string() }),
    execute: async ({ city }) => {
      assert(
        city === "Tokyo",
        `tool received wrong city argument (streamed JSON reassembly bug?): "${city}"`
      );
      return { city, condition: "sunny" };
    },
  });

  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Weather assistant.")
    .tool(getWeather)
    .build();
  const result = await agent.run("Weather in Tokyo?", { streamText: true });

  assert(
    result.content === "It's sunny in Tokyo.",
    `unexpected final content: "${result.content}"`
  );
  assert(result.finishReason === "stop", `expected stop, got ${result.finishReason}`);
  console.log(
    "✅ Real streaming — tool call args reassembled correctly from streamed JSON fragments, tool executes, final answer correct"
  );

  globalThis.fetch = originalFetch;
}

await testRealStreamingWhenEligible();
await testFallsBackWithOutputGuardrail();
await testFallsBackWithOutputSchema();
await testStreamedToolCallExecutesCorrectly();
console.log("\nAll real-streaming smoke tests passed.");
