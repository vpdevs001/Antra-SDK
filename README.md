# Antra SDK

The AI SDK for building type-safe, multi-provider AI agents with minimal boilerplate.

Antra gives you a single, provider-agnostic API for calling LLMs, defining tools, and running full agent loops — with real tool-calling (not hand-parsed JSON), multi-provider fallback, guardrails, structured output, memory, multi-agent handoffs, streaming, and tracing built in from the ground up.

```ts
import { Antra, Agent, defineTool } from "antra-sdk";
import { z } from "zod";

const client = new Antra({ apiKey: process.env.OPENAI_API_KEY! });

const getWeather = defineTool({
  name: "get_weather",
  description: "Get the current weather for a city",
  schema: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ city, tempC: 22, condition: "sunny" }),
});

const agent = Agent.builder()
  .client(client)
  .model("gpt-4o")
  .instructions("You are a helpful weather assistant.")
  .tool(getWeather)
  .build();

const result = await agent.run("What's the weather in Paris?");
console.log(result.content); // "It's 22°C and sunny in Paris."
```

---

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [Core concepts](#core-concepts)
- [The `Antra` client](#the-antra-client)
- [Tools](#tools)
- [Agents](#agents)
- [Guardrails](#guardrails)
- [Structured output](#structured-output)
- [Memory & sessions](#memory--sessions)
- [Handoffs](#handoffs)
- [Streaming & events](#streaming--events)
- [Tracing & reliability](#tracing--reliability)
- [Multi-provider & fallback](#multi-provider--fallback)
- [Built-in tools](#built-in-tools)
- [Error handling](#error-handling)
- [Full API reference](#full-api-reference)

---

## Installation

```bash
npm install antra-sdk zod
```

`zod` is a peer requirement — you'll use it to define tool schemas and structured output schemas. TypeScript is recommended but not required.

**Requirements:** Node.js ≥ 18 (uses native `fetch`, `AbortController`, and `ReadableStream`).

---

## Quick start

```ts
import { Antra } from "antra-sdk";

const client = new Antra({ apiKey: process.env.OPENAI_API_KEY! });

const result = await client.generate({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Say hello in one sentence." }],
});

console.log(result.content);
```

That's the client on its own — useful for simple one-shot completions. For anything involving tools, multi-step reasoning, or conversation state, use an `Agent` (see [Agents](#agents) below).

---

## Core concepts

Antra separates three things that are easy to conflate:

| Concept                      | What it is                                                       | Where it lives                           |
| ---------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| **Agent configuration**      | Static setup — model, instructions, tools, guardrails            | `AgentBuilder`, set once                 |
| **Run state**                | Everything scoped to one `run()` call — transcript, steps, trace | `AgentResult`                            |
| **Persistent session state** | Conversation history that outlives a single `run()` call         | `SessionStore`, addressed by `sessionId` |

Everything in the SDK builds on two primitives:

- **`Antra`** — the client. Talks to a model provider (OpenAI, Anthropic, or a fallback chain of both). Handles auth, streaming, and error mapping.
- **`Agent`** — the runtime. Wraps a client with instructions, tools, guardrails, and orchestrates the full tool-calling loop until a final answer comes back.

---

## The `Antra` client

### Construction

```ts
// Single provider (the common case)
const client = new Antra({ apiKey: process.env.OPENAI_API_KEY! });

// Explicit provider choice
const client = new Antra({ apiKey: process.env.ANTHROPIC_API_KEY!, provider: "anthropic" });

// Fallback chain — tries each provider in order on retryable failures
const client = new Antra({
  providers: [
    { provider: "openai", apiKey: process.env.OPENAI_API_KEY!, model: "gpt-4o" },
    {
      provider: "anthropic",
      apiKey: process.env.ANTHROPIC_API_KEY!,
      model: "claude-3-5-sonnet-latest",
    },
  ],
});
```

The API key is always passed explicitly to the constructor — there's no environment-variable fallback baked into the SDK. This is deliberate: no hidden global state, nothing surprising about where credentials come from.

### `generate()` — single-shot, buffered

```ts
const result = await client.generate({
  model: "gpt-4o",
  system: "You are terse.",
  messages: [{ role: "user", content: "What's 2+2?" }],
});
// result: { content, toolCalls, finishReason, usage, raw }
```

### `stream()` — token-level streaming

```ts
for await (const chunk of client.stream({ model: "gpt-4o", messages: [...] })) {
  if (chunk.type === "text_delta") process.stdout.write(chunk.text);
}
```

`StreamChunk` is a discriminated union: `text_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`, `finish`, `error`. This is provider-agnostic — the same shape comes out regardless of whether you're talking to OpenAI or Anthropic underneath.

Most of the time you won't call `client.stream()`/`generate()` directly — you'll use an `Agent`, which calls the client for you and adds the tool-calling loop, guardrails, memory, and tracing on top.

---

## Tools

Tools are defined with `defineTool()` — a zod schema in, fully-typed execution out. No manual JSON parsing, no separate type annotations.

```ts
import { defineTool } from "antra-sdk";
import { z } from "zod";

const searchOrders = defineTool({
  name: "search_orders",
  description: "Look up a customer's orders by email",
  schema: z.object({
    email: z.string().email(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  execute: async ({ email, limit }) => {
    // `email` and `limit` are fully typed here — inferred from the schema above.
    return await db.orders.findMany({ where: { email }, take: limit });
  },
});
```

- **Async tools** are fully supported — `execute` can be async, and the agent loop awaits it.
- **Validation** happens automatically — if the model's arguments don't match the schema, the agent catches it, turns it into a `ToolExecutionError`, and feeds the error back to the model as a tool result instead of crashing the run.
- **Errors thrown inside `execute`** are caught the same way — the model sees the failure and can react (retry differently, apologize, try another tool).

Tools are attached to an agent via `.tool()` / `.tools()` — see below.

---

## Agents

`Agent` is built with a chainable builder:

```ts
const agent = Agent.builder()
  .client(client) // required
  .model("gpt-4o") // required
  .name("support-agent") // optional, recommended if using handoffs
  .instructions("...") // system prompt
  .tool(myTool) // repeatable
  .tools([toolA, toolB]) // or add several at once
  .maxSteps(10) // default 10 — max model round-trips before giving up
  .useCotNudge(true) // default true — see below
  .onEvent(listener) // observability, see Streaming & events
  .build();
```

### Running an agent

```ts
const result = await agent.run("What's the weather in Paris?");

result.content; // final text answer
result.messages; // full transcript, including tool calls/results
result.finishReason; // "stop" | "max_steps" | "aborted" | "guardrail_blocked" | "limit_exceeded"
result.steps; // how many model round-trips it took
result.runId; // unique id for this run — see Tracing
result.trace; // structured execution record — see Tracing
```

### How the loop works

1. Send instructions + tools + conversation to the model.
2. If the model requests a tool call: validate arguments against the tool's schema, execute it, feed the result back, repeat.
3. If the model produces a final answer: run output guardrails (if any), return.
4. Stop when: the model gives a final answer, `maxSteps` is hit, the run is aborted, a guardrail blocks it, or a configured limit (`maxTokens`/`maxDurationMs`) is exceeded.

Tool calls always go through the model provider's **native tool-calling API** — never a hand-rolled JSON parsing protocol. This means tool arguments are structurally guaranteed valid JSON (or cleanly rejected via schema validation), and streaming, parallel tool calls, and error handling all work the way the underlying provider actually designed them to.

### Chain-of-thought nudge

By default (`useCotNudge: true`), a short instruction is appended to the system prompt encouraging the model to reason step-by-step before acting. This only shapes the model's own reasoning **text** — it has no bearing on control flow or tool execution, which always rides on the native tool-calling path regardless. Disable with `.useCotNudge(false)` if you'd rather write your own reasoning instructions from scratch.

### Cancellation

```ts
const controller = new AbortController();
const resultPromise = agent.run("...", { signal: controller.signal });
controller.abort(); // result resolves with finishReason: "aborted"
```

---

## Guardrails

Guardrails validate input, output, or tool calls — before or after they happen. Every guardrail registration requires an explicit `mode`:

- **`"strict"`** — a violation throws `GuardrailError`, rejecting the run outright.
- **`"soft"`** — a violation does **not** throw. Input/output guardrails end the run cleanly with `finishReason: "guardrail_blocked"`. Tool guardrails block just that one call and let the agent react (it sees the rejection as a tool result and can try something else).

There's no default — you choose per guardrail, every time.

### Input guardrails

```ts
agent = Agent.builder()
  // ...
  .inputGuardrail(
    (input) =>
      input.length > 5000 ? { passed: false, reason: "Input too long" } : { passed: true },
    { mode: "soft", name: "length-check" }
  )
  .build();
```

### Output guardrails

Output guardrails can also **modify** a passing response (e.g. redact PII) via `modifiedValue`:

```ts
.outputGuardrail((output) => {
  const redacted = output.replace(/\d{3}-\d{2}-\d{4}/g, "[REDACTED]");
  return redacted !== output ? { passed: true, modifiedValue: redacted } : { passed: true };
}, { mode: "soft" })
```

### Tool guardrails

Run before a requested tool call executes — can reject dangerous calls outright:

```ts
.toolGuardrail((toolCall) => {
  if (toolCall.name === "delete_file" && (toolCall.args as any).path.startsWith("/etc")) {
    return { passed: false, reason: "Refusing to delete system files" };
  }
  return { passed: true };
}, { mode: "strict" })
```

Guardrail activity shows up as `guardrail_triggered` events and in the run's `trace`.

---

## Structured output

Validate the model's final answer against a zod schema, with an automatic repair loop on failure:

```ts
const PersonSchema = z.object({ name: z.string(), age: z.number() });

const result = await agent.run("Ada is 36 years old.", {
  outputSchema: PersonSchema,
  maxRepairAttempts: 2, // default 2
});

result.output.name; // "Ada" — typed as `string`, inferred from the schema
result.output.age; // 36 — typed as `number`
```

If the model's response isn't valid JSON or doesn't match the schema, Antra automatically re-prompts it with the specific validation errors and retries — up to `maxRepairAttempts` times.

**Important:** `result.output` is only guaranteed present when the promise resolves — and it always resolves with valid, typed output when a schema is requested. If repairs are exhausted, or the run stops before producing valid output (aborted, guardrail-blocked, out of steps), `run()` **throws** `OutputValidationError` (or the relevant guardrail/abort error) rather than resolving without one. You never have to null-check `result.output`.

```ts
import { OutputValidationError } from "antra-sdk";

try {
  const result = await agent.run("...", { outputSchema: PersonSchema });
} catch (err) {
  if (err instanceof OutputValidationError) {
    console.log(err.rawOutput, err.attempts);
  }
}
```

---

## Memory & sessions

Multi-turn conversations, addressed by a `sessionId`:

```ts
await agent.run("My name is Sam.", { sessionId: "user-42" });
const result = await agent.run("What's my name?", { sessionId: "user-42" });
// result.content: "Your name is Sam."
```

No setup required — an `InMemorySessionStore` is created automatically the first time a `sessionId` is used. For durability across process restarts, swap it for `FileSessionStore`:

```ts
import { FileSessionStore } from "antra-sdk";

const agent = Agent.builder()
  // ...
  .sessionStore(new FileSessionStore({ dir: "./sessions" }))
  .build();
```

Both implement the same small `SessionStore` interface (`getMessages` / `setMessages` / `clear`), so a custom adapter (SQLite, Redis, anything) is a matter of implementing that interface — not forking the SDK.

Different `sessionId`s on the same agent never leak into each other.

---

## Handoffs

One agent can delegate to another — exposed to the model as a `handoff_to_<name>` tool, using the exact same native tool-calling path as any other tool.

```ts
const specialist = Agent.builder()
  .client(client)
  .model("gpt-4o")
  .name("billing-specialist")
  .instructions("You handle billing and refund questions.")
  .build();

const router = Agent.builder()
  .client(client)
  .model("gpt-4o")
  .name("router")
  .instructions("Route billing questions to the billing specialist.")
  .handoffs([specialist])
  .build();

const result = await router.run("I want a refund.");
result.handoffChain; // ["router", "billing-specialist"]
```

The **full conversation transcript** transfers to the target agent — not just a summary. `maxHandoffDepth` (default 5) is a hard loop-prevention limit; exceeding it throws `HandoffError` rather than hanging.

### Cyclic agent graphs

Two agents that hand off to each other can't both be passed to `.handoffs([...])` in the builder (neither exists yet when the other is being built). Wire the cycle after both are constructed:

```ts
const agentA = Agent.builder()./* ... */.build();
const agentB = Agent.builder()./* ... */.build();
agentA.addHandoff(agentB);
agentB.addHandoff(agentA);
```

---

## Streaming & events

Two ways to observe a run, backed by the exact same event source:

### Callback

```ts
const agent = Agent.builder()
  // ...
  .onEvent((event) => {
    if (event.type === "tool_call_start") console.log("calling", event.toolCall.name);
    if (event.type === "finish") console.log("done:", event.result.content);
  })
  .build();
```

### Async iterator

```ts
for await (const event of agent.stream("What's the weather?")) {
  if (event.type === "text_delta") process.stdout.write(event.text);
  if (event.type === "finish") console.log("\n\nDone:", event.result.content);
}
```

`agent.stream()` automatically opts into real token-level streaming. Plain `agent.run()` stays fully buffered by default; opt in per call with `{ streamText: true }`. Either way, streaming is **automatically skipped** (falls back to buffered) whenever an output guardrail or `outputSchema` is configured for that call — both need the complete response before they can validate it, so nothing gets shown to you before it's actually been checked.

### Event types

`step_start`, `text_delta`, `model_response`, `tool_call_start`, `tool_call_end`, `tool_call_error`, `guardrail_triggered`, `output_repair_attempted`, `retry_attempted`, `handoff_started`, `handoff_completed`, `finish`.

Every event carries a `runId` — filter on it if you're listening to an agent instance handling multiple concurrent runs.

---

## Tracing & reliability

### Automatic retries

Transient provider errors (rate limits, 5xx-class errors, timeouts) are retried automatically with exponential backoff:

```ts
.retry({ maxAttempts: 3, initialDelayMs: 500, maxDelayMs: 8000, backoffMultiplier: 2 }) // these are the defaults
```

Non-retryable errors (bad requests, auth failures) fail immediately — retrying them would just fail the same way again. When a provider tells you exactly how long to wait (`RateLimitError.retryAfterMs`), that's used instead of the computed backoff.

### Run-level limits

```ts
.maxTokens(50000)      // stop gracefully once accumulated usage crosses this
.maxDurationMs(60000)  // stop gracefully once wall-clock time crosses this
```

Both are checked at step boundaries — a backstop against runaway agents, not a hard per-request cap. Exceeding either ends the run with `finishReason: "limit_exceeded"` rather than throwing.

### Trace

Every run produces a structured `Trace` — model calls (with timing + token usage), tool calls, handoffs, retries, and errors:

```ts
const result = await agent.run("...");
result.trace.modelCalls; // [{ step, agentName, model, durationMs, usage, retries, streamed, ... }]
result.trace.toolCalls; // [{ step, toolName, durationMs, isError }]
result.trace.totalUsage; // accumulated token usage across the whole run

// Or look it up later, from any agent that participated in the run:
agent.getTrace(result.runId);
```

Across a handoff chain, every agent involved writes into the **same shared `Trace`** — so `router.getTrace(runId)` and `specialist.getTrace(runId)` return the identical object, with both agents' model calls in one place, not fragments you have to stitch together.

Traces are kept in memory per `Agent` instance (default cap 100, oldest evicted first — configure with `.maxStoredTraces(n)`).

---

## Multi-provider & fallback

Antra ships with `OpenAIProvider` and `AnthropicProvider`, both implementing the same `Provider` interface — so an `Agent` built against one works unmodified against the other.

```ts
const antra = new Antra({
  providers: [
    { provider: "openai", apiKey: OPENAI_KEY, model: "gpt-4o" },
    { provider: "anthropic", apiKey: ANTHROPIC_KEY, model: "claude-3-5-sonnet-latest" },
  ],
});
```

`FallbackProvider` tries each entry in order. It only retries on transient failures (`RateLimitError`, `ProviderError`, `TimeoutError`) — a bad request or an auth failure propagates immediately rather than being retried against a different provider (which would just hide the real problem). Each entry can specify its own `model`, since model IDs differ across providers.

Check what a provider (or fallback chain) actually supports before relying on it:

```ts
client.capabilities; // { supportsParallelToolCalls, supportsVision, supportsStreaming }
```

For a fallback chain, a capability is only reported `true` if **every** provider in the chain supports it.

---

## Built-in tools

### Web search

Backed by [Tavily](https://tavily.com):

```ts
import { createWebSearchTool } from "antra-sdk";

const webSearch = createWebSearchTool({
  apiKey: process.env.TAVILY_API_KEY!,
  defaultMaxResults: 5, // optional, default 5
  includeAnswer: true, // optional, default true
});

const agent = Agent.builder()
  // ...
  .tool(webSearch)
  .build();
```

Errors map onto the same typed error hierarchy as the model providers (`AuthError`, `RateLimitError`, etc.) — nothing special to learn for a different kind of external API.

---

## Error handling

Every error the SDK throws extends `AntraError`, with a stable `.code` and (where relevant) a `.provider`:

| Class                   | When                                                          |
| ----------------------- | ------------------------------------------------------------- |
| `AuthError`             | Invalid API key                                               |
| `RateLimitError`        | Rate limit hit (`.retryAfterMs` if the provider supplied one) |
| `InvalidRequestError`   | Malformed request                                             |
| `ContextLengthError`    | Input exceeded the model's context window                     |
| `TimeoutError`          | Request exceeded its timeout                                  |
| `CancelledError`        | Cancelled via `AbortController`                               |
| `ToolExecutionError`    | Tool args failed validation, or `execute()` threw             |
| `GuardrailError`        | A `"strict"`-mode guardrail rejected something                |
| `OutputValidationError` | Structured output never validated (repairs exhausted)         |
| `HandoffError`          | Handoff depth exceeded, or an unregistered target             |
| `ProviderError`         | Catch-all for provider-side failures                          |

```ts
import { isAntraError, RateLimitError } from "antra-sdk";

try {
  await agent.run("...");
} catch (err) {
  if (err instanceof RateLimitError) {
    console.log("retry after", err.retryAfterMs, "ms");
  } else if (isAntraError(err)) {
    console.log(err.code, err.message);
  }
}
```

---

## Full API reference

### Client

| Export                                                                                  | Description                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `Antra`                                                                                 | Main client — `generate()`, `stream()`, `.capabilities` |
| `AntraConfig`, `SingleProviderConfig`, `FallbackConfig`, `ProviderSpec`, `ProviderName` | Construction config types                               |
| `CallOptions`                                                                           | Per-call options for `generate()`/`stream()`            |

### Providers

| Export                                | Description                             |
| ------------------------------------- | --------------------------------------- |
| `Provider`, `ProviderCapabilities`    | The interface every provider implements |
| `OpenAIProvider`, `AnthropicProvider` | Built-in providers                      |
| `FallbackProvider`, `FallbackEntry`   | Multi-provider fallback chain           |

### Core types

`Message`, `ContentPart`, `Role`, `Usage`, `FinishReason`, `GenerateResult`, `GenerateOptions`, `StreamChunk`, `ToolCall`, `ToolDefinition`

### Tools

| Export                                       | Description                        |
| -------------------------------------------- | ---------------------------------- |
| `defineTool`, `Tool`                         | Define a tool from a zod schema    |
| `createWebSearchTool`, `WebSearchToolConfig` | Built-in Tavily-backed search tool |

### Agent

| Export                                                                                 | Description                       |
| -------------------------------------------------------------------------------------- | --------------------------------- |
| `Agent`, `AgentBuilder`                                                                | The agent runtime and its builder |
| `AgentRunOptions`, `StructuredRunOptions`                                              | Options for `run()`/`stream()`    |
| `AgentEvent`, `AgentListener`, `AgentResult`, `AgentFinishReason`                      | Observability & result types      |
| `Trace`, `TraceModelCall`, `TraceToolCall`, `TraceHandoff`, `TraceRetry`, `TraceError` | Structured execution record       |
| `RetryConfig`                                                                          | Retry/backoff configuration       |

### Guardrails

`GuardrailMode`, `GuardrailResult`, `InputGuardrail`, `OutputGuardrail`, `ToolGuardrail`

### Memory

| Export                                       | Description                                    |
| -------------------------------------------- | ---------------------------------------------- |
| `SessionStore`                               | The interface — implement for a custom adapter |
| `InMemorySessionStore`                       | Default, zero-setup                            |
| `FileSessionStore`, `FileSessionStoreConfig` | Durable, one JSON file per session             |

### Errors

`AntraError`, `AuthError`, `RateLimitError`, `InvalidRequestError`, `ContextLengthError`, `TimeoutError`, `CancelledError`, `ToolExecutionError`, `GuardrailError`, `OutputValidationError`, `HandoffError`, `ProviderError`, `isAntraError`

---

## Design principles

1. **Type safety is not opt-in.** Full inference from a tool's zod schema through to `execute()`'s arguments and `run()`'s structured output — no manual annotations needed anywhere.
2. **Fail loudly, fail specifically.** No silent fallbacks. Every failure maps to a typed error with enough context to act on.
3. **No magic.** No hidden global state, no implicit retries you didn't ask for, no behavior that depends on undocumented defaults.
4. **Predictable across providers, honest about differences.** One interface for OpenAI/Anthropic; genuine capability differences are surfaced via `.capabilities`, never papered over.
5. **Minimal dependencies.** `zod` is the only runtime dependency.
6. **Boilerplate is a bug.** The common case is a few lines; advanced use is possible, not the default path.
7. **Agent-ready by default.** Tool calling, streaming, and multi-step loops are first-class, not a bolt-on.
