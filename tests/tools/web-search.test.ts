import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Antra, Agent, createWebSearchTool, AuthError, TimeoutError } from "../../src/index.js";

describe("createWebSearchTool (Tavily)", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("direct execution returns correctly mapped results", async () => {
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

    expect(capturedBody.api_key).toBe("test-tavily-key");
    expect(capturedBody.max_results).toBe(3);
    expect(result.answer).toBe("The Eiffel Tower is 330 meters tall.");
    expect(result.results[0]?.snippet).toBe("The tower stands 330m tall.");
  });

  it("maps a 401 response to AuthError", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 })) as typeof fetch;

    const webSearch = createWebSearchTool({ apiKey: "bad-key" });
    await expect(webSearch.execute({ query: "anything" })).rejects.toThrow(AuthError);
  });

  it("a hanging request times out with TimeoutError", async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        );
      })) as typeof fetch;

    const webSearch = createWebSearchTool({ apiKey: "test-key", timeoutMs: 30 });
    await expect(webSearch.execute({ query: "this will hang" })).rejects.toThrow(TimeoutError);
  });

  it("works end-to-end through an Agent: model requests it, it executes, produces final answer", async () => {
    let callCount = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      callCount++;
      if (url.includes("tavily.com")) {
        return new Response(
          JSON.stringify({
            answer: "It's -2°C and snowing in Reykjavik.",
            results: [
              {
                title: "Reykjavik weather",
                url: "https://example.com/w",
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
                        arguments: '{"query":"weather in Reykjavik"}',
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
              message: { content: "It's -2°C and snowing.", tool_calls: undefined },
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

    const result = await agent.run("What's the weather in Reykjavik?");

    expect(result.content).toBe("It's -2°C and snowing.");
    expect(result.finishReason).toBe("stop");
    expect(result.trace.toolCalls[0]?.toolName).toBe("web_search");
  });
});
