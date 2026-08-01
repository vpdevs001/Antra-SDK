/**
 * Smoke test for the fallback chain — verifies:
 * 1. A retryable failure (e.g. 500/ProviderError) on the primary falls
 *    through to the next provider, which succeeds.
 * 2. A non-retryable failure (e.g. 401/AuthError) does NOT trigger
 *    fallback — retrying a bad-request-shaped error against a different
 *    provider would just hide the real problem.
 * 3. The same Agent from Chapter 4 runs unmodified against a fallback
 *    client, proving nothing above it needed to change.
 */
import { z } from "zod";
import { Antra, Agent, defineTool } from "./src/index.js";
import { AuthError } from "./src/errors/index.js";

let callCount = 0;

function mockFetchSequence(responses: Array<() => Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const responder = responses[callCount] ?? responses[responses.length - 1];
    callCount++;
    return responder!();
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function testFallbackOnRetryableError() {
  callCount = 0;
  const restore = mockFetchSequence([
    // Primary (openai) call — simulate a 500.
    () =>
      new Response(JSON.stringify({ error: { message: "internal server error" } }), {
        status: 500,
      }),
    // Fallback (anthropic) call — succeeds.
    () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Answered by fallback." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
        { status: 200 }
      ),
  ]);

  const antra = new Antra({
    providers: [
      { provider: "openai", apiKey: "openai-key", model: "gpt-4o" },
      { provider: "anthropic", apiKey: "anthropic-key", model: "claude-3-5-sonnet-latest" },
    ],
  });

  const result = await antra.generate({
    model: "gpt-4o", // overridden per-entry via `model` in the provider spec
    messages: [{ role: "user", content: "hi" }],
  });

  console.assert(
    result.content === "Answered by fallback.",
    `expected fallback response, got "${result.content}"`
  );
  console.assert(
    callCount === 2,
    `expected exactly 2 fetch calls (primary fail + fallback success), got ${callCount}`
  );
  console.log(
    "✅ FallbackProvider — retryable failure on primary correctly falls through to secondary"
  );

  restore();
}

async function testNoFallbackOnAuthError() {
  callCount = 0;
  const restore = mockFetchSequence([
    () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }),
    () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "should never be reached" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 }
      ),
  ]);

  const antra = new Antra({
    providers: [
      { provider: "openai", apiKey: "bad-key", model: "gpt-4o" },
      { provider: "anthropic", apiKey: "anthropic-key", model: "claude-3-5-sonnet-latest" },
    ],
  });

  try {
    await antra.generate({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });
    console.error("❌ expected AuthError to propagate without falling back");
  } catch (err) {
    console.assert(
      err instanceof AuthError,
      `expected AuthError, got ${(err as Error).constructor.name}`
    );
    console.assert(
      callCount === 1,
      `expected exactly 1 fetch call (no fallback attempt), got ${callCount}`
    );
    console.log("✅ FallbackProvider — non-retryable AuthError correctly skips fallback");
  }

  restore();
}

async function testAgentUnmodifiedOnFallbackClient() {
  callCount = 0;
  // NOTE: FallbackProvider is stateless per-call — it retries from the
  // primary on *every* generate() call, not just the first. So across
  // the agent's 2 steps, the primary is tried (and fails) twice.
  const restore = mockFetchSequence([
    // Step 1: primary (openai) fails.
    () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 500 }),
    // Step 1: fallback (anthropic) — model requests a tool.
    () =>
      new Response(
        JSON.stringify({
          content: [
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 30, output_tokens: 10 },
        }),
        { status: 200 }
      ),
    // Step 2: primary (openai) fails again.
    () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 500 }),
    // Step 2: fallback (anthropic) — model gives final answer after tool result.
    () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: "It's 22°C in Paris." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 40, output_tokens: 8 },
        }),
        { status: 200 }
      ),
  ]);

  const getWeather = defineTool({
    name: "get_weather",
    description: "Get current weather for a city",
    schema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, tempC: 22 }),
  });

  const antra = new Antra({
    providers: [
      { provider: "openai", apiKey: "openai-key", model: "gpt-4o" },
      { provider: "anthropic", apiKey: "anthropic-key", model: "claude-3-5-sonnet-latest" },
    ],
  });

  // Same Agent API from Chapter 4 — zero changes needed for a fallback-backed client.
  const agent = Agent.builder()
    .client(antra)
    .model("gpt-4o")
    .instructions("Weather assistant.")
    .tool(getWeather)
    .build();

  const result = await agent.run("Weather in Paris?");

  console.assert(
    result.content === "It's 22°C in Paris.",
    `unexpected final content: "${result.content}"`
  );
  console.assert(result.finishReason === "stop", `unexpected finishReason: ${result.finishReason}`);
  console.assert(
    callCount === 4,
    `expected 4 fetch calls (2 failed primary attempts + 2 fallback round-trips), got ${callCount}`
  );
  console.log("✅ Agent runs unmodified against a fallback-backed Antra client");

  restore();
}

await testFallbackOnRetryableError();
await testNoFallbackOnAuthError();
await testAgentUnmodifiedOnFallbackClient();
console.log("\nAll fallback smoke tests passed.");
