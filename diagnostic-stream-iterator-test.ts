/**
 * DIAGNOSTIC #2 — isolates Agent.stream() (the async-iterator wrapping
 * around run(), via AsyncEventQueue) specifically, since diagnostic #1
 * proved run() itself works correctly.
 */
import { z } from "zod";
import { Antra, Agent, defineTool } from "./src/index.js";

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

const getWeather = defineTool({
  name: "get_weather",
  description: "Get current weather for a city",
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 22 }),
});

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

let callCount = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const idx = callCount;
  callCount++;
  const body = JSON.parse(init.body as string);
  console.log(`\n[fetch call #${idx}] stream=${body.stream} messageCount=${body.messages?.length}`);
  const lines = streamLines[idx] ?? streamLines[streamLines.length - 1];
  return sseResponse(lines);
}) as typeof fetch;

const agent = Agent.builder()
  .client(client)
  .model("gpt-4o")
  .instructions("Weather assistant.")
  .tool(getWeather)
  .build();

console.log("=== Starting agent.stream() ===");
let eventCount = 0;
for await (const event of agent.stream("Weather in Paris?")) {
  eventCount++;
  if (event.type === "text_delta") {
    console.log(`[iterator event #${eventCount}] text_delta: ${JSON.stringify(event.text)}`);
  } else if (event.type === "finish") {
    console.log(
      `[iterator event #${eventCount}] finish — content: ${JSON.stringify(event.result.content)}`
    );
  } else {
    console.log(`[iterator event #${eventCount}] ${event.type}`);
  }
}

console.log(`\nTotal fetch calls made: ${callCount}`);
console.log(`Total events yielded by the iterator: ${eventCount}`);

globalThis.fetch = originalFetch;
