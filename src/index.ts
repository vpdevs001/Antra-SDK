export { Antra } from "./client.js";
export type {
  AntraConfig,
  CallOptions,
  ProviderName,
  ProviderSpec,
  SingleProviderConfig,
  FallbackConfig,
} from "./client.js";

export { AnthropicProvider } from "./providers/anthropic/provider.js";
export { OpenAIProvider } from "./providers/openai/provider.js";
export { FallbackProvider } from "./providers/fallback.js";
export type { FallbackEntry } from "./providers/fallback.js";

export type {
  Message,
  ContentPart,
  Role,
  Usage,
  FinishReason,
  GenerateResult,
  GenerateOptions,
  StreamChunk,
  ToolCall,
  ToolDefinition,
} from "./core/types.js";

export type { Provider, ProviderCapabilities } from "./core/provider.js";

export {
  AntraError,
  AuthError,
  RateLimitError,
  InvalidRequestError,
  ContextLengthError,
  TimeoutError,
  CancelledError,
  ToolExecutionError,
  ProviderError,
  isAntraError,
} from "./errors/index.js";

export { defineTool } from "./tools/define-tool.js";
export type { Tool } from "./tools/define-tool.js";

export { Agent, AgentBuilder } from "./agent/agent.js";
export type { AgentRunOptions } from "./agent/agent.js";
export type { AgentEvent, AgentListener, AgentResult, AgentFinishReason } from "./agent/types.js";
