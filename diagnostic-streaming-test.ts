/**
 * DIAGNOSTIC VERSION — temporary, verbose logging added to pinpoint why
 * the real streaming path fails on the second sequential stream() call
 * within one Agent.run() loop on some environments but not others.
 * Not a permanent test file.
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
  const body = JSON.parse(init.body as string);
  const idx = callCount;
  callCount++;
  console.log(
    `\n[fetch call #${idx}] url=${url} stream=${body.stream} messageCount=${body.messages?.length}`
  );
  const lines = streamLines[idx] ?? streamLines[streamLines.length - 1];
  console.log(`[fetch call #${idx}] responding with ${lines.length} SSE lines`);
  return sseResponse(lines);
}) as typeof fetch;

const agent = Agent.builder()
  .client(client)
  .model("gpt-4o")
  .instructions("Weather assistant.")
  .tool(getWeather)
  .onEvent((e) => {
    if (e.type === "text_delta") {
      console.log(`[event] text_delta: ${JSON.stringify(e.text)}`);
    } else {
      console.log(`[event] ${e.type}`);
    }
  })
  .build();

console.log("=== Starting run() with streamText: true ===");
const result = await agent.run("Weather in Paris?", { streamText: true });
console.log("\n=== Final result ===");
console.log(JSON.stringify(result, null, 2));
console.log(`\nTotal fetch calls made: ${callCount}`);

globalThis.fetch = originalFetch;
