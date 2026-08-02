/**
 * Smoke test for Chapter 10 — streaming & events.
 * Covers: agent.stream() (async iterator) produces the exact same event
 * sequence as onEvent() (callback) for the same run, the final result is
 * readable off the terminal "finish" event, and errors thrown inside
 * run() (e.g. a strict guardrail) propagate correctly through the
 * generator rather than being swallowed.
 */
import { z } from "zod";
import { Antra, Agent, defineTool, GuardrailError } from "./src/index.js";

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

function mockStreamSequence(responderLines: Array<object[]>) {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const lines = responderLines[callCount] ?? responderLines[responderLines.length - 1];
    callCount++;
    return sseResponse(lines!);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// Non-streaming mock, for the error-propagation test (never reaches the model at all).
function mockGenerateSequence(responders: Array<(body: any) => object>) {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const responder = responders[callCount] ?? responders[responders.length - 1];
    callCount++;
    return new Response(JSON.stringify(responder!(body)), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

const client = new Antra({ apiKey: "test-key" });

const getWeather = defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 22 }),
});

// --- 1. stream() and onEvent() see the identical event sequence for the same scenario, on identical (real-streaming) transport ---
async function testStreamMatchesOnEventSequence() {
  const streamLines: Array<object[]> = [
    [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ],
    [
      { choices: [{ delta: { content: "It's 22" }, finish_reason: null }] },
      { choices: [{ delta: { content: "°C in Paris." }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      },
    ],
  ];

  // Run #1: consumed via onEvent (callback), explicitly on real-streaming transport.
  const restore1 = mockStreamSequence(streamLines);
  const eventsViaCallback: string[] = [];
  const agent1 = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Weather assistant.")
    .tool(getWeather)
    .onEvent((e) => eventsViaCallback.push(e.type))
    .build();
  await agent1.run("Weather in Paris?", { streamText: true });
  restore1();

  // Run #2: identical scenario, consumed via stream() (async iterator) — which defaults to real-streaming transport too.
  const restore2 = mockStreamSequence(streamLines);
  const eventsViaStream: string[] = [];
  let finalResultFromStream: any;
  const agent2 = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Weather assistant.")
    .tool(getWeather)
    .build();
  for await (const event of agent2.stream("Weather in Paris?")) {
    eventsViaStream.push(event.type);
    if (event.type === "finish") finalResultFromStream = event.result;
  }
  restore2();

  assert(
    JSON.stringify(eventsViaCallback) === JSON.stringify(eventsViaStream),
    `event sequences differ:\n  callback: ${eventsViaCallback.join(",")}\n  stream:   ${eventsViaStream.join(",")}`
  );
  assert(
    eventsViaStream.includes("text_delta"),
    "expected real text_delta events on both paths — same transport, same events"
  );
  assert(
    finalResultFromStream.content === "It's 22°C in Paris.",
    `final result from stream's finish event is wrong: "${finalResultFromStream.content}"`
  );
  console.log(
    "✅ stream() and onEvent() produce identical event sequences (including real text_delta) for the same run"
  );
  console.log(`   sequence: ${eventsViaStream.join(" → ")}`);
}

// --- 2. Errors thrown inside run() (e.g. strict guardrail) propagate through the generator ---
async function testStreamPropagatesErrors() {
  const restore = mockGenerateSequence([
    () => ({
      choices: [{ message: { content: "should never be reached" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  ]);

  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Assistant.")
    .inputGuardrail(
      (input) =>
        input.includes("blocked") ? { passed: false, reason: "Blocked input" } : { passed: true },
      { mode: "strict" }
    )
    .build();

  const seenEvents: string[] = [];
  try {
    for await (const event of agent.stream("This should be blocked.")) {
      seenEvents.push(event.type);
    }
    console.error("❌ expected GuardrailError to propagate through the async iterator");
  } catch (err) {
    assert(
      err instanceof GuardrailError,
      `expected GuardrailError, got ${(err as Error).constructor.name}`
    );
    console.log("✅ Errors thrown inside run() propagate correctly through stream()");
  }

  restore();
}

await testStreamMatchesOnEventSequence();
await testStreamPropagatesErrors();
console.log("\nAll streaming/events smoke tests passed.");
