import { z } from "zod";
import { defineTool, type Tool } from "../define-tool.js";
import { mapTavilyError } from "./web-search-errors.js";
import { TimeoutError, ProviderError } from "../../errors/index.js";

const DEFAULT_BASE_URL = "https://api.tavily.com";

export interface WebSearchToolConfig {
  apiKey: string;
  baseURL?: string;
  /** Default max results per search if the model doesn't specify one. 1-10. Default 5. */
  defaultMaxResults?: number;
  /** Whether to ask Tavily for a synthesized answer alongside raw results. Default true — usually cheaper for the model to consume than raw snippets alone. */
  includeAnswer?: boolean;
  timeoutMs?: number;
}

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilySearchResponse {
  answer?: string;
  results: TavilySearchResult[];
}

const searchArgsSchema = z.object({
  query: z.string().describe("The search query."),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Maximum number of results to return (1-10). Defaults to the tool's configured default."
    ),
});

/**
 * Creates a `web_search` tool backed by Tavily's search API — proves
 * the tool-authoring path built in Chapter 3/4 is sufficient for a
 * real tool, not just toy examples: this is a `defineTool()` call like
 * any other, no private SDK internals required.
 *
 * @example
 * const webSearch = createWebSearchTool({ apiKey: process.env.TAVILY_API_KEY! });
 * const agent = Agent.builder().client(client).model("gpt-4o")
 *   .instructions("Research assistant.")
 *   .tool(webSearch)
 *   .build();
 */
export function createWebSearchTool(config: WebSearchToolConfig): Tool<typeof searchArgsSchema> {
  const baseURL = config.baseURL ?? DEFAULT_BASE_URL;
  const timeoutMs = config.timeoutMs ?? 15_000;
  const defaultMaxResults = config.defaultMaxResults ?? 5;
  const includeAnswer = config.includeAnswer ?? true;

  return defineTool({
    name: "web_search",
    description:
      "Search the web for current information. Use this for questions about recent events, facts you're unsure about, or anything that could have changed since your training data.",
    schema: searchArgsSchema,
    execute: async ({ query, maxResults }) => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new TimeoutError("Web search timed out", { provider: "tavily" })),
        timeoutMs
      );

      let response: Response;
      try {
        response = await fetch(`${baseURL}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: config.apiKey,
            query,
            max_results: maxResults ?? defaultMaxResults,
            include_answer: includeAnswer,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new TimeoutError("Web search timed out", { provider: "tavily", cause: err });
        }
        throw new ProviderError(err instanceof Error ? err.message : "Web search request failed", {
          provider: "tavily",
          cause: err,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw await mapTavilyError(response);
      }

      const body = (await response.json()) as TavilySearchResponse;

      return {
        answer: body.answer,
        results: body.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
      };
    },
  });
}
