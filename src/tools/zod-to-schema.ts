import { z } from "zod";

/**
 * Converts a zod schema to JSON Schema, covering the subset of zod
 * actually needed for tool parameter definitions (objects, primitives,
 * arrays, enums, optionals, defaults, descriptions).
 *
 * We hand-roll this instead of depending on `zod-to-json-schema` to keep
 * the dependency footprint minimal — tool schemas don't need the full
 * spec, just enough for providers to understand the shape.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def;

  // Unwrap optional/default/nullable wrappers, but track optionality upstream via .isOptional()
  if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault") {
    return zodToJsonSchema(def.innerType ?? def.type);
  }
  if (def.typeName === "ZodNullable") {
    const inner = zodToJsonSchema(def.innerType);
    return { ...inner, nullable: true };
  }

  const description = schema.description ? { description: schema.description } : {};

  switch (def.typeName) {
    case "ZodString":
      return { type: "string", ...description };
    case "ZodNumber":
      return { type: "number", ...description };
    case "ZodBoolean":
      return { type: "boolean", ...description };
    case "ZodEnum":
      return { type: "string", enum: def.values, ...description };
    case "ZodArray":
      return { type: "array", items: zodToJsonSchema(def.type), ...description };
    case "ZodObject": {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const fieldSchema = value as z.ZodTypeAny;
        properties[key] = zodToJsonSchema(fieldSchema);
        if (!fieldSchema.isOptional()) required.push(key);
      }
      return {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        ...description,
      };
    }
    default:
      // Fallback: accept anything. Better than throwing for uncommon zod types.
      return { ...description };
  }
}
