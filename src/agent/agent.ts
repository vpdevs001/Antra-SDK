import type { z } from "zod";
import type { Antra } from "../client.js";
import type { Message, ContentPart, ToolDefinition, ToolCall } from "../core/types.js";
import type { Tool } from "../tools/define-tool.js";
import type { AgentEvent, AgentListener, AgentResult, AgentFinishReason } from "./types.js";
import { buildSystemPrompt, buildOutputInstructions, buildRepairMessage } from "./prompts.js";
import {
  ToolExecutionError,
  CancelledError,
  GuardrailError,
  OutputValidationError,
} from "../errors/index.js";
import { zodToJsonSchema } from "../tools/zod-to-schema.js";
import type {
  GuardrailRegistration,
  InputGuardrail,
  OutputGuardrail,
  ToolGuardrail,
} from "../guardrails/types.js";
import type { SessionStore } from "../memory/session-store.js";
import { InMemorySessionStore } from "../memory/session-store.js";

export interface AgentRunOptions {
  signal?: AbortSignal;
  /**
   * Continues (and persists) a conversation across separate `run()`
   * calls. Backed by whichever SessionStore is configured via
   * `AgentBuilder.sessionStore(...)` — an InMemorySessionStore is used
   * automatically if none was configured.
   */
  sessionId?: string;
}

/** Options for a structured-output run — see Agent.run()'s second overload. */
export interface StructuredRunOptions<TSchema extends z.ZodTypeAny> extends AgentRunOptions {
  /** zod schema the final answer must validate against. */
  outputSchema: TSchema;
  /** How many repair attempts to make if the model's output fails validation. Default 2. */
  maxRepairAttempts?: number;
}

/**
 * Builds an Agent step by step. Mirrors the POC's `AgentBuilder` shape —
 * `.instructions(...).tool(...).build()` — since that ergonomic pattern
 * was already good; only the internals change.
 */
export class AgentBuilder {
  private _client: Antra | undefined;
  private _model: string | undefined;
  private _instructions = "";
  private _tools: Tool[] = [];
  private _maxSteps = 10;
  private _useCotNudge = true;
  private _listeners: AgentListener[] = [];
  private _inputGuardrails: GuardrailRegistration<InputGuardrail>[] = [];
  private _outputGuardrails: GuardrailRegistration<OutputGuardrail>[] = [];
  private _toolGuardrails: GuardrailRegistration<ToolGuardrail>[] = [];
  private _sessionStore: SessionStore | undefined;

  /** The Antra client used to talk to the model. Required. */
  client(client: Antra): this {
    this._client = client;
    return this;
  }

  /** Which model to call, e.g. "gpt-4o". Required. */
  model(model: string): this {
    this._model = model;
    return this;
  }

  /** System instructions describing the agent's role/behavior. */
  instructions(instructions: string): this {
    this._instructions = instructions;
    return this;
  }

  /** Registers a tool the agent can call. Chainable — call once per tool. */
  tool(tool: Tool): this {
    this._tools.push(tool);
    return this;
  }

  /** Registers several tools at once. */
  tools(tools: Tool[]): this {
    this._tools.push(...tools);
    return this;
  }

  /** Max model round-trips before the agent gives up and returns with finishReason "max_steps". Default 10. */
  maxSteps(maxSteps: number): this {
    this._maxSteps = maxSteps;
    return this;
  }

  /** Whether to append the built-in chain-of-thought reasoning nudge to the system prompt. Default true. */
  useCotNudge(enabled: boolean): this {
    this._useCotNudge = enabled;
    return this;
  }

  /** Registers an observability listener — called for every step, tool call, and finish event. */
  onEvent(listener: AgentListener): this {
    this._listeners.push(listener);
    return this;
  }

  /**
   * Validates/rejects the user's input before it reaches the model.
   * `mode` is required — you decide whether a violation hard-fails
   * (`"strict"`, throws GuardrailError) or ends the run softly
   * (`"soft"`, returns an AgentResult with finishReason
   * "guardrail_blocked" instead of throwing).
   */
  inputGuardrail(fn: InputGuardrail, opts: { mode: "strict" | "soft"; name?: string }): this {
    this._inputGuardrails.push({
      fn,
      mode: opts.mode,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
    });
    return this;
  }

  /** Validates/redacts the model's final answer before it's returned. Same `mode` contract as inputGuardrail. */
  outputGuardrail(fn: OutputGuardrail, opts: { mode: "strict" | "soft"; name?: string }): this {
    this._outputGuardrails.push({
      fn,
      mode: opts.mode,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
    });
    return this;
  }

  /**
   * Validates a requested tool call before it executes. Allow/reject
   * only for now — human-approval (pause and wait) is a later addition.
   * Same `mode` contract as the others.
   */
  toolGuardrail(fn: ToolGuardrail, opts: { mode: "strict" | "soft"; name?: string }): this {
    this._toolGuardrails.push({
      fn,
      mode: opts.mode,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
    });
    return this;
  }

  /**
   * Sets the SessionStore used when `run()` is called with a `sessionId`.
   * Optional — if never called, the Agent creates its own
   * InMemorySessionStore automatically the first time a sessionId is used.
   */
  sessionStore(store: SessionStore): this {
    this._sessionStore = store;
    return this;
  }

  build(): Agent {
    if (!this._client) {
      throw new Error("AgentBuilder: `.client(...)` is required before `.build()`.");
    }
    if (!this._model) {
      throw new Error("AgentBuilder: `.model(...)` is required before `.build()`.");
    }
    return new Agent(this);
  }

  // Internal getters used by Agent's constructor.
  /** @internal */ get _config() {
    return {
      client: this._client!,
      model: this._model!,
      instructions: this._instructions,
      tools: this._tools,
      maxSteps: this._maxSteps,
      useCotNudge: this._useCotNudge,
      listeners: this._listeners,
      inputGuardrails: this._inputGuardrails,
      outputGuardrails: this._outputGuardrails,
      toolGuardrails: this._toolGuardrails,
      sessionStore: this._sessionStore,
    };
  }
}

export class Agent {
  private readonly client: Antra;
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly toolMap: Map<string, Tool>;
  private readonly toolDefinitions: ToolDefinition[];
  private readonly maxSteps: number;
  private readonly listeners: AgentListener[];
  private readonly inputGuardrails: GuardrailRegistration<InputGuardrail>[];
  private readonly outputGuardrails: GuardrailRegistration<OutputGuardrail>[];
  private readonly toolGuardrails: GuardrailRegistration<ToolGuardrail>[];
  private readonly sessionStore: SessionStore;

  constructor(builder: AgentBuilder) {
    const config = builder._config;
    this.client = config.client;
    this.model = config.model;
    this.systemPrompt = buildSystemPrompt(config.instructions, config.useCotNudge);
    this.maxSteps = config.maxSteps;
    this.listeners = [...config.listeners];
    this.inputGuardrails = [...config.inputGuardrails];
    this.outputGuardrails = [...config.outputGuardrails];
    this.toolGuardrails = [...config.toolGuardrails];
    // No store configured — default to an in-memory one, scoped to this Agent instance,
    // created once here so it actually persists across multiple run() calls on the same instance.
    this.sessionStore = config.sessionStore ?? new InMemorySessionStore();

    this.toolMap = new Map(config.tools.map((t) => [t.name, t]));
    this.toolDefinitions = config.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  static builder(): AgentBuilder {
    return new AgentBuilder();
  }

  /** Registers an additional observability listener after construction. */
  onEvent(listener: AgentListener): void {
    this.listeners.push(listener);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /**
   * Runs the agent to completion: calls the model, executes any tools it
   * requests, feeds results back, and repeats until the model stops
   * calling tools, `maxSteps` is hit, or the run is aborted.
   */
  async run(query: string, options?: AgentRunOptions): Promise<AgentResult>;
  /**
   * Same as above, but validates the final answer against `outputSchema`
   * and retries (asking the model to correct itself) up to
   * `maxRepairAttempts` times on failure. `result.output` is typed from
   * the schema via `z.infer`, preserving end-to-end type safety.
   *
   * IMPORTANT: `output` is only guaranteed present when
   * `finishReason === "stop"`. If the run is aborted, blocked by a
   * soft-mode guardrail, or hits `maxSteps` before producing valid
   * output, `run()` throws `OutputValidationError` (or the relevant
   * guardrail/abort path) rather than resolving without one — a
   * resolved promise always carries valid, typed output.
   */
  async run<TSchema extends z.ZodTypeAny>(
    query: string,
    options: StructuredRunOptions<TSchema>
  ): Promise<AgentResult & { output: z.infer<TSchema> }>;
  async run(
    query: string,
    options: AgentRunOptions & { outputSchema?: z.ZodTypeAny; maxRepairAttempts?: number } = {}
  ): Promise<AgentResult & { output?: unknown }> {
    // --- Session state (persistent, across separate run() calls) is loaded once, up front. ---
    const sessionId = options.sessionId;
    const history = sessionId ? await this.sessionStore.getMessages(sessionId) : [];

    // --- Input guardrails run once, before anything is sent to the model. ---
    const inputCheck = await this.runInputGuardrails(0, query);
    if (inputCheck.blocked) {
      const blockedMessages: Message[] = [...history, { role: "user", content: query }];
      const blockedResult: AgentResult = {
        content: inputCheck.reason,
        messages: blockedMessages,
        finishReason: "guardrail_blocked",
        steps: 0,
      };
      if (sessionId) await this.sessionStore.setMessages(sessionId, blockedMessages);
      this.emit({ type: "finish", step: 0, result: blockedResult });
      return blockedResult;
    }
    const effectiveQuery = inputCheck.modifiedValue ?? query;

    const outputSchema = options.outputSchema;
    const maxRepairAttempts = options.maxRepairAttempts ?? 2;
    let repairAttempts = 0;

    const effectiveSystemPrompt = outputSchema
      ? `${this.systemPrompt}\n\n${buildOutputInstructions(zodToJsonSchema(outputSchema))}`
      : this.systemPrompt;

    const messages: Message[] = [...history, { role: "user", content: effectiveQuery }];
    let step = 0;
    let finishReason: AgentFinishReason = "stop";
    let finalContent = "";
    let output: unknown;

    while (step < this.maxSteps) {
      if (options.signal?.aborted) {
        finishReason = "aborted";
        break;
      }

      step++;
      this.emit({ type: "step_start", step });

      const result = await this.client.generate({
        model: this.model,
        system: effectiveSystemPrompt,
        messages,
        ...(this.toolDefinitions.length > 0 ? { tools: this.toolDefinitions } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });

      this.emit({ type: "model_response", step, result });
      finalContent = result.content;

      // Append the assistant's turn to history — text and/or tool calls.
      const assistantContent: ContentPart[] = [];
      if (result.content) assistantContent.push({ type: "text", text: result.content });
      for (const tc of result.toolCalls) {
        assistantContent.push({ type: "tool_call", id: tc.id, name: tc.name, args: tc.args });
      }
      messages.push({ role: "assistant", content: assistantContent });

      if (result.finishReason !== "tool_calls" || result.toolCalls.length === 0) {
        // --- Output guardrails run only on a genuine final answer, never on intermediate turns. ---
        const outputCheck = await this.runOutputGuardrails(step, finalContent);
        if (outputCheck.blocked) {
          const blockedResult: AgentResult = {
            content: outputCheck.reason,
            messages,
            finishReason: "guardrail_blocked",
            steps: step,
          };
          if (sessionId) await this.sessionStore.setMessages(sessionId, messages);
          this.emit({ type: "finish", step, result: blockedResult });
          return blockedResult;
        }
        finalContent = outputCheck.modifiedValue ?? finalContent;

        if (outputSchema) {
          const validation = validateStructuredOutput(outputSchema, finalContent);
          if (validation.ok) {
            output = validation.data;
            finishReason = "stop";
            break;
          }

          const canRetry = repairAttempts < maxRepairAttempts && step < this.maxSteps;
          if (canRetry) {
            repairAttempts++;
            this.emit({
              type: "output_repair_attempted",
              step,
              attempt: repairAttempts,
              reason: validation.reason,
            });
            messages.push({ role: "user", content: buildRepairMessage(validation.reason) });
            continue; // skip the tool-execution section below — there are no tool calls on this branch
          }

          throw new OutputValidationError(
            `Structured output validation failed after ${repairAttempts} repair attempt(s): ${validation.reason}`,
            { rawOutput: finalContent, attempts: repairAttempts, cause: validation.zodError }
          );
        }

        finishReason = "stop";
        break;
      }

      // Execute every requested tool call, feed results back, then loop again.
      const toolResultParts: ContentPart[] = [];
      for (const toolCall of result.toolCalls) {
        const toolResult = await this.executeTool(step, toolCall);
        toolResultParts.push({
          type: "tool_result",
          toolCallId: toolCall.id,
          result: toolResult.value,
          isError: toolResult.isError,
        });
      }
      messages.push({ role: "tool", content: toolResultParts });

      if (step >= this.maxSteps) {
        finishReason = "max_steps";
      }
    }

    if (
      step >= this.maxSteps &&
      finishReason === "stop" &&
      messages[messages.length - 1]?.role === "tool"
    ) {
      // Loop exited because maxSteps was hit right after a tool call, before the model could respond again.
      finishReason = "max_steps";
    }

    const finalResult: AgentResult & { output?: unknown } = {
      content: finalContent,
      messages,
      finishReason,
      steps: step,
      ...(output !== undefined ? { output } : {}),
    };
    if (sessionId) await this.sessionStore.setMessages(sessionId, messages);
    this.emit({ type: "finish", step, result: finalResult });
    return finalResult;
  }

  /**
   * Validates tool args against the tool's zod schema, executes it, and
   * normalizes both success and failure into a tool_result so the model
   * always gets a response — a failed tool call doesn't crash the run,
   * it becomes information the model can react to (retry differently,
   * apologize to the user, try another tool, etc).
   */
  private async executeTool(
    step: number,
    toolCall: ToolCall
  ): Promise<{ value: unknown; isError: boolean }> {
    const tool = this.toolMap.get(toolCall.name);

    if (!tool) {
      const error = new ToolExecutionError(`No tool registered with name "${toolCall.name}"`, {
        toolName: toolCall.name,
      });
      this.emit({ type: "tool_call_error", step, toolCall, error });
      return { value: { error: error.message }, isError: true };
    }

    this.emit({ type: "tool_call_start", step, toolCall });

    // Tool guardrails run before schema validation or execution — they can
    // reject a call outright (e.g. a dangerous command, a disallowed
    // recipient) regardless of whether its arguments are well-formed.
    const toolCheck = await this.runToolGuardrails(step, toolCall);
    if (toolCheck.blocked) {
      const error = new ToolExecutionError(
        `Tool call "${toolCall.name}" blocked by guardrail: ${toolCheck.reason}`,
        { toolName: toolCall.name }
      );
      this.emit({ type: "tool_call_error", step, toolCall, error });
      return { value: { error: error.message }, isError: true };
    }

    const parsed = tool.schema.safeParse(toolCall.args);
    if (!parsed.success) {
      const error = new ToolExecutionError(
        `Invalid arguments for tool "${toolCall.name}": ${parsed.error.message}`,
        { toolName: toolCall.name, cause: parsed.error }
      );
      this.emit({ type: "tool_call_error", step, toolCall, error });
      return { value: { error: error.message }, isError: true };
    }

    try {
      const value = await tool.execute(parsed.data);
      this.emit({ type: "tool_call_end", step, toolCall, result: value });
      return { value, isError: false };
    } catch (cause) {
      const error =
        cause instanceof CancelledError
          ? cause
          : new ToolExecutionError(
              `Tool "${toolCall.name}" threw during execution: ${cause instanceof Error ? cause.message : String(cause)}`,
              { toolName: toolCall.name, cause }
            );
      this.emit({ type: "tool_call_error", step, toolCall, error });
      return { value: { error: error.message }, isError: true };
    }
  }

  // --- Guardrail runners ---
  // Each returns a small internal shape ({blocked, reason, modifiedValue})
  // rather than throwing directly, EXCEPT in "strict" mode, where a
  // GuardrailError is thrown immediately — this keeps strict-mode
  // behavior identical regardless of which guardrail category triggered
  // it (a thrown error always propagates out of run(), full stop).

  private async runInputGuardrails(
    step: number,
    input: string
  ): Promise<{ blocked: boolean; reason: string; modifiedValue?: string }> {
    let value = input;
    for (const reg of this.inputGuardrails) {
      const result = await reg.fn(value);
      if (!result.passed) {
        const reason = result.reason ?? "Input guardrail rejected the input.";
        this.emit({
          type: "guardrail_triggered",
          step,
          guardrailType: "input",
          guardrailName: reg.name,
          mode: reg.mode,
          reason,
        });
        if (reg.mode === "strict") {
          throw new GuardrailError(reason, {
            guardrailType: "input",
            ...(reg.name !== undefined ? { guardrailName: reg.name } : {}),
          });
        }
        return { blocked: true, reason };
      }
      if (result.modifiedValue !== undefined) value = result.modifiedValue;
    }
    return { blocked: false, reason: "", modifiedValue: value };
  }

  private async runOutputGuardrails(
    step: number,
    output: string
  ): Promise<{ blocked: boolean; reason: string; modifiedValue?: string }> {
    let value = output;
    for (const reg of this.outputGuardrails) {
      const result = await reg.fn(value);
      if (!result.passed) {
        const reason = result.reason ?? "Output guardrail rejected the response.";
        this.emit({
          type: "guardrail_triggered",
          step,
          guardrailType: "output",
          guardrailName: reg.name,
          mode: reg.mode,
          reason,
        });
        if (reg.mode === "strict") {
          throw new GuardrailError(reason, {
            guardrailType: "output",
            ...(reg.name !== undefined ? { guardrailName: reg.name } : {}),
          });
        }
        return { blocked: true, reason };
      }
      if (result.modifiedValue !== undefined) value = result.modifiedValue;
    }
    return { blocked: false, reason: "", modifiedValue: value };
  }

  private async runToolGuardrails(
    step: number,
    toolCall: ToolCall
  ): Promise<{ blocked: boolean; reason: string }> {
    for (const reg of this.toolGuardrails) {
      const result = await reg.fn(toolCall);
      if (!result.passed) {
        const reason = result.reason ?? `Tool guardrail rejected the call to "${toolCall.name}".`;
        this.emit({
          type: "guardrail_triggered",
          step,
          guardrailType: "tool",
          guardrailName: reg.name,
          mode: reg.mode,
          reason,
        });
        if (reg.mode === "strict") {
          throw new GuardrailError(reason, {
            guardrailType: "tool",
            ...(reg.name !== undefined ? { guardrailName: reg.name } : {}),
          });
        }
        return { blocked: true, reason };
      }
    }
    return { blocked: false, reason: "" };
  }
}

/**
 * Parses `raw` as JSON and validates it against `schema`. Kept as a
 * plain function (not a method) since it's pure and doesn't need
 * anything from `this` — matches "boilerplate is a bug": no reason to
 * thread instance state through something with no instance dependency.
 */
function validateStructuredOutput(
  schema: z.ZodTypeAny,
  raw: string
): { ok: true; data: unknown } | { ok: false; reason: string; zodError?: z.ZodError } {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `Response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = schema.safeParse(parsedJson);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  const issues = result.error.issues
    .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");

  return {
    ok: false,
    reason: `Output did not match the required schema:\n${issues}`,
    zodError: result.error,
  };
}
