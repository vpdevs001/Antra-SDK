/**
 * Smoke test for Chapter 7 — structured output.
 * Covers: valid JSON on the first try (typed output), self-repair after
 * an invalid first attempt, and OutputValidationError thrown once
 * repair attempts are exhausted.
 */
import { z } from "zod";
import { Antra, Agent, OutputValidationError } from "./src/index.js";

function mockGenerateSequence(responders: Array<(body: any) => object>) {
  let callCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const responder = responders[callCount] ?? responders[responders.length - 1];
    callCount++;
    return new Response(JSON.stringify(responder!(body)), { status: 200 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    getCallCount: () => callCount,
  };
}

const client = new Antra({ apiKey: "test-key" });

const PersonSchema = z.object({
  name: z.string(),
  age: z.number(),
});

// --- 1. Valid JSON on the first try ---
async function testHappyPath() {
  const { restore } = mockGenerateSequence([
    (body) => {
      // Verify the schema instructions actually made it into the system prompt.
      console.assert(body.messages !== undefined, "messages missing");
      const systemMsg = body.messages.find((m: any) => m.role === "system");
      console.assert(
        systemMsg?.content.includes('"name"'),
        "output schema instructions not in system prompt"
      );
      return {
        choices: [
          {
            message: { content: '{"name":"Ada","age":36}', tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      };
    },
  ]);

  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Extract person info.")
    .build();
  const result = await agent.run("Ada is 36 years old.", { outputSchema: PersonSchema });

  // Type-level check: `result.output` is inferred as { name: string; age: number } — this line
  // wouldn't compile if inference were broken.
  const age: number = result.output.age;

  console.assert(result.output.name === "Ada", `unexpected name: ${result.output.name}`);
  console.assert(age === 36, `unexpected age: ${age}`);
  console.assert(result.finishReason === "stop", `expected stop, got ${result.finishReason}`);
  console.log("✅ Structured output — valid JSON on first try, typed output correct");

  restore();
}

// --- 2. Self-repair: invalid JSON first, then valid ---
async function testRepairLoop() {
  const events: string[] = [];
  const { restore, getCallCount } = mockGenerateSequence([
    () => ({
      // Malformed: missing required "age" field.
      choices: [
        { message: { content: '{"name":"Grace"}', tool_calls: undefined }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    }),
    (body) => {
      const lastUserMsg = body.messages[body.messages.length - 1];
      console.assert(
        lastUserMsg.content.includes("did not match"),
        "repair message not sent to model"
      );
      return {
        choices: [
          {
            message: { content: '{"name":"Grace","age":45}', tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      };
    },
  ]);

  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Extract person info.")
    .onEvent((e) => events.push(e.type))
    .build();

  const result = await agent.run("Grace is 45.", { outputSchema: PersonSchema });

  console.assert(
    result.output.name === "Grace" && result.output.age === 45,
    "repaired output incorrect"
  );
  console.assert(
    events.includes("output_repair_attempted"),
    "missing output_repair_attempted event"
  );
  console.assert(
    getCallCount() === 2,
    `expected 2 model calls (1 fail + 1 repaired success), got ${getCallCount()}`
  );
  console.log("✅ Structured output — self-repair after invalid first attempt succeeds");

  restore();
}

// --- 3. Repairs exhausted: throws OutputValidationError ---
async function testExhaustedRepairsThrows() {
  const { restore, getCallCount } = mockGenerateSequence([
    () => ({
      choices: [
        { message: { content: "not json at all", tool_calls: undefined }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  ]); // every call returns invalid content

  const agent = Agent.builder()
    .client(client)
    .model("gpt-4o")
    .instructions("Extract person info.")
    .build();

  try {
    await agent.run("Whoever.", { outputSchema: PersonSchema, maxRepairAttempts: 2 });
    console.error("❌ expected OutputValidationError to be thrown");
  } catch (err) {
    console.assert(
      err instanceof OutputValidationError,
      `expected OutputValidationError, got ${(err as Error).constructor.name}`
    );
    console.assert(
      (err as OutputValidationError).attempts === 2,
      `expected 2 attempts recorded, got ${(err as OutputValidationError).attempts}`
    );
    // 1 initial attempt + 2 repair attempts = 3 model calls total.
    console.assert(getCallCount() === 3, `expected 3 model calls, got ${getCallCount()}`);
    console.log("✅ Structured output — repairs exhausted correctly throws OutputValidationError");
  }

  restore();
}

await testHappyPath();
await testRepairLoop();
await testExhaustedRepairsThrows();
console.log("\nAll structured output smoke tests passed.");
