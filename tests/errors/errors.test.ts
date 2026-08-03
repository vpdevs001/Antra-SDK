import { describe, it, expect } from "vitest";
import {
  AntraError,
  AuthError,
  RateLimitError,
  InvalidRequestError,
  ContextLengthError,
  TimeoutError,
  CancelledError,
  ToolExecutionError,
  GuardrailError,
  OutputValidationError,
  HandoffError,
  ProviderError,
  isAntraError,
} from "../../src/errors/index.js";

describe("error hierarchy", () => {
  it("every subclass extends AntraError and carries a stable code", () => {
    const cases: Array<[AntraError, string]> = [
      [new AuthError("x"), "auth_error"],
      [new RateLimitError("x"), "rate_limit_error"],
      [new InvalidRequestError("x"), "invalid_request_error"],
      [new ContextLengthError("x"), "context_length_error"],
      [new TimeoutError("x"), "timeout_error"],
      [new CancelledError("x"), "cancelled_error"],
      [new ToolExecutionError("x", { toolName: "t" }), "tool_execution_error"],
      [new GuardrailError("x", { guardrailType: "input" }), "guardrail_error"],
      [new OutputValidationError("x", { rawOutput: "y", attempts: 1 }), "output_validation_error"],
      [new HandoffError("x", { fromAgent: "a", toAgent: "b" }), "handoff_error"],
      [new ProviderError("x"), "provider_error"],
    ];

    for (const [err, code] of cases) {
      expect(err).toBeInstanceOf(AntraError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(isAntraError(err)).toBe(true);
    }
  });

  it("isAntraError returns false for plain errors and non-errors", () => {
    expect(isAntraError(new Error("plain"))).toBe(false);
    expect(isAntraError("not an error")).toBe(false);
    expect(isAntraError(undefined)).toBe(false);
  });

  it("RateLimitError carries retryAfterMs when provided", () => {
    const withRetry = new RateLimitError("rate limited", { retryAfterMs: 3000 });
    expect(withRetry.retryAfterMs).toBe(3000);

    const withoutRetry = new RateLimitError("rate limited");
    expect(withoutRetry.retryAfterMs).toBeUndefined();
  });

  it("GuardrailError carries guardrailType and optional guardrailName", () => {
    const err = new GuardrailError("blocked", {
      guardrailType: "tool",
      guardrailName: "danger-check",
    });
    expect(err.guardrailType).toBe("tool");
    expect(err.guardrailName).toBe("danger-check");
  });

  it("OutputValidationError carries rawOutput and attempts", () => {
    const err = new OutputValidationError("invalid", { rawOutput: "{bad json", attempts: 2 });
    expect(err.rawOutput).toBe("{bad json");
    expect(err.attempts).toBe(2);
  });

  it("HandoffError carries fromAgent and toAgent", () => {
    const err = new HandoffError("depth exceeded", { fromAgent: "router", toAgent: "specialist" });
    expect(err.fromAgent).toBe("router");
    expect(err.toAgent).toBe("specialist");
  });

  it("errors preserve `cause` for debugging", () => {
    const original = new Error("network down");
    const wrapped = new ProviderError("request failed", { cause: original });
    expect(wrapped.cause).toBe(original);
  });
});
