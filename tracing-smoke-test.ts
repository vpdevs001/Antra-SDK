/**
 * Smoke test for Chapter 11 — tracing & reliability.
 * Covers: automatic retry with backoff on a transient error (and NOT on
 * a non-retryable one), maxTokens and maxDurationMs stopping a run
 * gracefully, runId shared across a handoff chain with one merged
 * Trace, and agent.getTrace(runId) returning that trace after the fact.
 */
import { z } from "zod";
import { Antra, Agent, defineTool, AuthError } from "./src/index.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function mockFetchSequence(responders: Array<() => Response>) {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const responder = responders[callCount] ?? responders[responders.length - 1];
    callCount++;
    return responder!();
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    getCallCount: () => callCount,
  };
}

const client = new Antra({ apiKey: "test-key" });

// --- 1. Retryable error (500) succeeds after retrying, respects config ---
async function testRetrySucceedsAfterTransientError() {
  const { restore, getCallCount } = mockFetchSequence([
    () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 500 }),
    () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: "Recovered.", tool_calls: undefined }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
        { status: 200 }
      ),
  ]);

  const events: string[] = [];
  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Assistant.")
    .retry({ maxAttempts: 3, initialDelayMs: 5, maxDelayMs: 20 }) // tiny delays so the test runs fast
    .onEvent((e) => events.push(e.type))
    .build();

  const result = await agent.run("Hello");

  assert(result.content === "Recovered.", `expected recovery after retry, got "${result.content}"`);
  assert(
    getCallCount() === 2,
    `expected 2 fetch calls (1 fail + 1 retry success), got ${getCallCount()}`
  );
  assert(events.includes("retry_attempted"), "missing retry_attempted event");
  assert(
    result.trace.retries.length === 1,
    `expected 1 recorded retry in trace, got ${result.trace.retries.length}`
  );
  assert(
    result.trace.modelCalls[0]?.retries === 1,
    `expected modelCalls[0].retries === 1, got ${result.trace.modelCalls[0]?.retries}`
  );
  console.log("✅ Retry — transient 500 recovers after one retry, recorded in trace + event");

  restore();
}

// --- 2. Non-retryable error (401) does NOT retry ---
async function testNonRetryableErrorDoesNotRetry() {
  const { restore, getCallCount } = mockFetchSequence([
    () => new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 }),
  ]);

  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Assistant.")
    .retry({ initialDelayMs: 5 })
    .build();

  try {
    await agent.run("Hello");
    console.error("❌ expected AuthError to propagate without retrying");
  } catch (err) {
    assert(err instanceof AuthError, `expected AuthError, got ${(err as Error).constructor.name}`);
    assert(
      getCallCount() === 1,
      `expected exactly 1 fetch call (no retries on AuthError), got ${getCallCount()}`
    );
    console.log("✅ Retry — non-retryable AuthError correctly skips retry logic");
  }

  restore();
}

// --- 3. maxTokens stops the run gracefully ---
async function testMaxTokensLimitsRun() {
  const getWeather = defineTool({
    name: "get_weather",
    description: "Get weather",
    schema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, tempC: 20 }),
  });

  const { restore } = mockFetchSequence([
    () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"city":"NYC"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 5000, completion_tokens: 5000, total_tokens: 10000 },
        }),
        { status: 200 }
      ),
  ]); // every call burns 10k tokens — should exceed a small maxTokens fast

  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Assistant.")
    .tool(getWeather)
    .maxTokens(15000)
    .maxSteps(20)
    .build();

  const result = await agent.run("Weather everywhere?");

  assert(
    result.finishReason === "limit_exceeded",
    `expected limit_exceeded, got ${result.finishReason}`
  );
  assert(
    result.trace.totalUsage.totalTokens >= 15000 || result.steps <= 3,
    `expected the run to stop quickly once tokens crossed the limit, got ${result.steps} steps / ${result.trace.totalUsage.totalTokens} tokens`
  );
  console.log(
    `✅ maxTokens — run stopped gracefully with limit_exceeded after ${result.steps} step(s), ${result.trace.totalUsage.totalTokens} tokens used`
  );

  restore();
}

// --- 4. maxDurationMs stops the run gracefully ---
async function testMaxDurationLimitsRun() {
  const { restore } = mockFetchSequence([
    () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "call_x", type: "function", function: { name: "noop", arguments: "{}" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 }
      ),
  ]);

  const noop = defineTool({
    name: "noop",
    description: "no-op",
    schema: z.object({}),
    execute: async () => ({ ok: true }),
  });

  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Assistant.")
    .tool(noop)
    .maxDurationMs(1)
    .maxSteps(1000)
    .build();

  // Give the first step a moment to run, then the SECOND step's boundary check should trip on elapsed time.
  const result = await agent.run("Loop forever if you can.");

  assert(
    result.finishReason === "limit_exceeded",
    `expected limit_exceeded, got ${result.finishReason}`
  );
  console.log(
    `✅ maxDurationMs — run stopped gracefully with limit_exceeded after ${result.steps} step(s)`
  );

  restore();
}

// --- 5. runId shared across a handoff chain; one merged Trace; getTrace() works after the fact ---
async function testRunIdAndTraceAcrossHandoff() {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    callCount++;
    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "handoff_to_specialist",
                      arguments: '{"reason":"billing question"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content: "Handled by specialist.", tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const specialist = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .name("specialist")
    .instructions("Handles billing.")
    .build();
  const router = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .name("router")
    .instructions("Routes billing questions.")
    .handoffs([specialist])
    .build();

  const routerEvents: string[] = [];
  const routerRunIds = new Set<string>();
  router.onEvent((e) => {
    routerEvents.push(e.type);
    routerRunIds.add(e.runId);
  });

  const result = await router.run("I have a billing question.");

  assert(
    routerRunIds.size === 1,
    `expected exactly 1 distinct runId across the whole chain, got ${routerRunIds.size}`
  );
  assert(
    [...routerRunIds][0] === result.runId,
    "the runId seen in events doesn't match the final result's runId"
  );
  assert(
    result.trace.agentNames.includes("router") && result.trace.agentNames.includes("specialist"),
    `expected both agent names in trace.agentNames, got ${JSON.stringify(result.trace.agentNames)}`
  );
  assert(
    result.trace.handoffs.length === 1,
    `expected 1 handoff recorded in trace, got ${result.trace.handoffs.length}`
  );
  assert(
    result.trace.modelCalls.length === 2,
    `expected 2 model calls recorded in the shared trace (router + specialist), got ${result.trace.modelCalls.length}`
  );

  // getTrace() works from EITHER agent in the chain, since it's the same shared object.
  const traceFromRouter = router.getTrace(result.runId);
  const traceFromSpecialist = specialist.getTrace(result.runId);
  assert(traceFromRouter !== undefined, "router.getTrace(runId) returned undefined");
  assert(traceFromSpecialist !== undefined, "specialist.getTrace(runId) returned undefined");
  assert(
    traceFromRouter === traceFromSpecialist,
    "expected the SAME trace object reference from both agents"
  );

  console.log(
    "✅ Handoff tracing — one runId, one merged Trace across both agents, getTrace() works from either agent"
  );

  globalThis.fetch = originalFetch;
}

await testRetrySucceedsAfterTransientError();
await testNonRetryableErrorDoesNotRetry();
await testMaxTokensLimitsRun();
await testMaxDurationLimitsRun();
await testRunIdAndTraceAcrossHandoff();
console.log("\nAll tracing/reliability smoke tests passed.");
