/**
 * Smoke test for Chapter 4 — verifies the Agent loop: model requests a
 * tool, we execute it via defineTool()'s validated executor, feed the
 * result back, model gives a final answer. All through native
 * tool-calling, no hand-parsed JSON.
 */
import { z } from "zod";
import { Antra, Agent, defineTool } from "./src/index.js";

const originalFetch = globalThis.fetch;
let callCount = 0;

globalThis.fetch = (async (_url: string, init: RequestInit) => {
  callCount++;
  const body = JSON.parse(init.body as string);

  if (callCount === 1) {
    // First call: model decides to call the weather tool.
    console.assert(
      body.tools?.[0]?.function?.name === "get_weather",
      "tool definition not sent to model"
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
                  function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
      }),
      { status: 200 }
    );
  }

  // Second call: model has the tool result in message history, gives final answer.
  const toolMessage = body.messages.find((m: { role: string }) => m.role === "tool");
  console.assert(toolMessage !== undefined, "tool result message not fed back to model");
  console.assert(toolMessage.content.includes("22"), "tool result content missing expected data");

  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: "It's 22°C and sunny in Paris.", tool_calls: undefined },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 70, completion_tokens: 12, total_tokens: 82 },
    }),
    { status: 200 }
  );
}) as typeof fetch;

const getWeather = defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  schema: z.object({ city: z.string().describe("City name") }),
  execute: async ({ city }) => {
    // `city` is fully typed as string here — no manual parsing.
    return { city, tempC: 22, condition: "sunny" };
  },
});

const client = new Antra({ apiKey: "test-key" });

const events: string[] = [];
const agent = Agent.builder()
  .client(client)
  .model("gpt-4o")
  .instructions("You are a helpful weather assistant.")
  .tool(getWeather)
  .onEvent((e) => events.push(e.type))
  .build();

const result = await agent.run("What's the weather in Paris?");

console.assert(
  result.content === "It's 22°C and sunny in Paris.",
  `unexpected final content: "${result.content}"`
);
console.assert(result.finishReason === "stop", `unexpected finishReason: ${result.finishReason}`);
console.assert(result.steps === 2, `expected 2 steps, got ${result.steps}`);
console.assert(events.includes("tool_call_start"), "missing tool_call_start event");
console.assert(events.includes("tool_call_end"), "missing tool_call_end event");
console.assert(events.includes("finish"), "missing finish event");
console.assert(callCount === 2, `expected 2 model calls, got ${callCount}`);

console.log("Event sequence:", events.join(" → "));
console.log("Final answer:", result.content);
console.log("✅ Agent loop — tool call → tool result → final answer, all via native tool-calling");

globalThis.fetch = originalFetch;
