import type { Antra } from "../client.js";
import type { Message, ContentPart, ToolDefinition, ToolCall } from "../core/types.js";
import type { Tool } from "../tools/define-tool.js";
import type { AgentEvent, AgentListener, AgentResult, AgentFinishReason } from "./types.js";
import { buildSystemPrompt } from "./prompts.js";
import { ToolExecutionError, CancelledError } from "../errors/index.js";

export interface AgentRunOptions {
  signal?: AbortSignal;
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

  constructor(builder: AgentBuilder) {
    const config = builder._config;
    this.client = config.client;
    this.model = config.model;
    this.systemPrompt = buildSystemPrompt(config.instructions, config.useCotNudge);
    this.maxSteps = config.maxSteps;
    this.listeners = [...config.listeners];

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
  async run(query: string, options: AgentRunOptions = {}): Promise<AgentResult> {
    const messages: Message[] = [{ role: "user", content: query }];
    let step = 0;
    let finishReason: AgentFinishReason = "stop";
    let finalContent = "";

    while (step < this.maxSteps) {
      if (options.signal?.aborted) {
        finishReason = "aborted";
        break;
      }

      step++;
      this.emit({ type: "step_start", step });

      const result = await this.client.generate({
        model: this.model,
        system: this.systemPrompt,
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

    const finalResult: AgentResult = { content: finalContent, messages, finishReason, steps: step };
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
}
