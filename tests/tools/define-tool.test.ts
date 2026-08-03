import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool } from "../../src/tools/define-tool.js";

describe("defineTool", () => {
  it("derives name, description, and JSON Schema parameters from the zod schema", () => {
    const tool = defineTool({
      name: "get_weather",
      description: "Get the weather for a city",
      schema: z.object({
        city: z.string().describe("City name"),
        units: z.enum(["celsius", "fahrenheit"]).optional(),
      }),
      execute: async ({ city }) => ({ city, tempC: 20 }),
    });

    expect(tool.name).toBe("get_weather");
    expect(tool.description).toBe("Get the weather for a city");
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
        units: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["city"],
    });
  });

  it("execute() receives fully-typed, validated args and can be awaited", async () => {
    const tool = defineTool({
      name: "add",
      description: "Add two numbers",
      schema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => a + b,
    });

    const result = await tool.execute({ a: 2, b: 3 });
    expect(result).toBe(5);
  });

  it("nested objects and arrays convert to JSON Schema correctly", () => {
    const tool = defineTool({
      name: "create_order",
      description: "Create an order",
      schema: z.object({
        items: z.array(z.object({ sku: z.string(), qty: z.number() })),
      }),
      execute: async (args) => args,
    });

    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { sku: { type: "string" }, qty: { type: "number" } },
            required: ["sku", "qty"],
          },
        },
      },
      required: ["items"],
    });
  });

  it("optional fields are excluded from `required`", () => {
    const tool = defineTool({
      name: "search",
      description: "Search",
      schema: z.object({ query: z.string(), limit: z.number().optional() }),
      execute: async (args) => args,
    });

    const params = tool.parameters as { required: string[] };
    expect(params.required).toEqual(["query"]);
  });
});
