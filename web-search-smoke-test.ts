/**
 * Smoke test for Chapter 12 — the built-in web_search tool (Tavily).
 * Covers: direct execution success, HTTP error mapping onto the typed
 * error hierarchy, timeout handling, and end-to-end use through an
 * Agent (model requests the tool, it executes, final answer produced).
 */
import { Antra, Agent, createWebSearchTool, AuthError, TimeoutError } from "./src/index.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// --- 1. Direct execution: successful search returns mapped results ---
async function testDirectSearchSuccess() {
  const originalFetch = globalThis.fetch;
  let capturedBody: any;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    capturedBody = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({
        answer: "The Eiffel Tower is 330 meters tall.",
        results: [
          {
            title: "Eiffel Tower height",
            url: "https://example.com/eiffel",
            content: "The tower stands 330m tall.",
            score: 0.98,
          },
        ],
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const webSearch = createWebSearchTool({ apiKey: "test-tavily-key", defaultMaxResults: 3 });
  const result = (await webSearch.execute({ query: "how tall is the eiffel tower" })) as {
    answer?: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  };

  assert(capturedBody.api_key === "test-tavily-key", "api_key not sent in request body");
  assert(
    capturedBody.max_results === 3,
    `expected default max_results 3, got ${capturedBody.max_results}`
  );
  assert(result.answer === "The Eiffel Tower is 330 meters tall.", "answer field missing/wrong");
  assert(
    result.results.length === 1 && result.results[0]!.snippet === "The tower stands 330m tall.",
    "results mapping wrong"
  );
  console.log("✅ web_search — direct execution succeeds, correctly mapped result shape");

  globalThis.fetch = originalFetch;
}

// --- 2. Error mapping: a 401 from Tavily maps to AuthError ---
async function testErrorMapping() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 })) as typeof fetch;

  const webSearch = createWebSearchTool({ apiKey: "bad-key" });
  try {
    await webSearch.execute({ query: "anything" });
    console.error("❌ expected AuthError to be thrown");
  } catch (err) {
    assert(err instanceof AuthError, `expected AuthError, got ${(err as Error).constructor.name}`);
    console.log("✅ web_search — 401 from Tavily correctly maps to AuthError");
  }

  globalThis.fetch = originalFetch;
}

// --- 3. Timeout: a hanging request is aborted after timeoutMs ---
async function testTimeout() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError"))
      );
    });
  }) as typeof fetch;

  const webSearch = createWebSearchTool({ apiKey: "test-key", timeoutMs: 30 });
  try {
    await webSearch.execute({ query: "this will hang" });
    console.error("❌ expected TimeoutError to be thrown");
  } catch (err) {
    assert(
      err instanceof TimeoutError,
      `expected TimeoutError, got ${(err as Error).constructor.name}`
    );
    console.log("✅ web_search — hanging request correctly times out with TimeoutError");
  }

  globalThis.fetch = originalFetch;
}

// --- 4. End-to-end through an Agent: model requests the tool, it executes, final answer produced ---
async function testEndToEndThroughAgent() {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    callCount++;
    if (url.includes("tavily.com")) {
      const body = JSON.parse(init.body as string);
      assert(
        body.query === "current weather in Reykjavik",
        `unexpected search query: "${body.query}"`
      );
      return new Response(
        JSON.stringify({
          answer: "It's currently -2°C and snowing in Reykjavik.",
          results: [
            {
              title: "Reykjavik weather",
              url: "https://example.com/weather",
              content: "-2°C, snow",
              score: 0.9,
            },
          ],
        }),
        { status: 200 }
      );
    }
    const body = JSON.parse(init.body as string);
    if (callCount === 1) {
      assert(
        body.tools?.some((t: any) => t.function.name === "web_search"),
        "web_search tool not offered to the model"
      );
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
                      name: "web_search",
                      arguments: '{"query":"current weather in Reykjavik"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "It's -2°C and snowing in Reykjavik right now.",
              tool_calls: undefined,
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
      }),
      { status: 200 }
    );
  }) as typeof fetch;

  const client = new Antra({ apiKey: "test-key" });
  const webSearch = createWebSearchTool({ apiKey: "test-tavily-key" });
  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Research assistant.")
    .tool(webSearch)
    .build();

  const result = await agent.run("What's the weather in Reykjavik right now?");

  assert(
    result.content === "It's -2°C and snowing in Reykjavik right now.",
    `unexpected final content: "${result.content}"`
  );
  assert(result.finishReason === "stop", `expected stop, got ${result.finishReason}`);
  assert(
    result.trace.toolCalls.length === 1 && result.trace.toolCalls[0]!.toolName === "web_search",
    "web_search call not recorded in trace"
  );
  console.log(
    "✅ web_search — end-to-end through an Agent: model calls it, executes for real, produces final answer"
  );

  globalThis.fetch = originalFetch;
}

await testDirectSearchSuccess();
await testErrorMapping();
await testTimeout();
await testEndToEndThroughAgent();
console.log("\nAll web_search smoke tests passed.");
