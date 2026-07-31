import { z } from "zod";
import { zodToJsonSchema } from "./zod-to-schema.js";

/**
 * A tool with its argument types inferred from the zod schema.
 * `execute` receives fully-typed, validated args — no manual parsing needed.
 */
export interface Tool<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: TSchema;
  /** JSON Schema derived from `schema`, sent to the provider. */
  parameters: Record<string, unknown>;
  execute: (args: z.infer<TSchema>) => Promise<unknown> | unknown;
}

/**
 * Defines a tool with end-to-end type safety: the shape of `schema`
 * determines the type of `args` inside `execute`, with zero manual
 * type annotations required.
 *
 * @example
 * const getWeather = defineTool({
 *   name: "get_weather",
 *   description: "Get the current weather for a city",
 *   schema: z.object({ city: z.string().describe("City name") }),
 *   execute: async ({ city }) => {
 *     // `city` is typed as `string` automatically
 *     return { tempC: 22, condition: "sunny" };
 *   },
 * });
 */
export function defineTool<TSchema extends z.ZodTypeAny>(config: {
  name: string;
  description: string;
  schema: TSchema;
  execute: (args: z.infer<TSchema>) => Promise<unknown> | unknown;
}): Tool<TSchema> {
  return {
    name: config.name,
    description: config.description,
    schema: config.schema,
    parameters: zodToJsonSchema(config.schema),
    execute: config.execute,
  };
}
