/** Typed API errors that are safe to render back to callers. */

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "method_not_allowed"
  | "payload_too_large"
  | "upstream_error"
  | "empty_response"
  | "reasoning_budget_exhausted"
  | "internal_error";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly field: string | null;

  constructor(
    message: string,
    options: { code?: ErrorCode; status?: number; field?: string | null } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = options.code ?? "internal_error";
    this.status = options.status ?? 500;
    this.field = options.field ?? null;
  }
}

export const invalidRequest = (message: string, field?: string) =>
  new ApiError(message, { code: "invalid_request", status: 400, field });

export const unauthorized = (message: string) => new ApiError(message, { code: "unauthorized", status: 401 });

export const notFound = (message: string) => new ApiError(message, { code: "not_found", status: 404 });

export const methodNotAllowed = () =>
  new ApiError("Method not allowed.", { code: "method_not_allowed", status: 405 });

export const payloadTooLarge = (message: string) =>
  new ApiError(message, { code: "payload_too_large", status: 413 });

export const upstreamError = (message: string, code: ErrorCode = "upstream_error") =>
  new ApiError(message, { code, status: 502 });

export function legacyErrorPayload(error: ApiError, requestId: string): Record<string, unknown> {
  return {
    request_id: requestId,
    error: { code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) },
  };
}

export function openAiErrorPayload(error: ApiError, requestId: string): Record<string, unknown> {
  return {
    error: {
      message: error.message,
      type: errorType(error),
      param: error.field,
      code: error.code,
    },
    request_id: requestId,
  };
}

function errorType(error: ApiError): string {
  if (error.status === 401) return "authentication_error";
  if (error.status === 404) return "not_found_error";
  if (error.status === 429) return "rate_limit_error";
  if (error.status >= 500) return "api_error";
  return "invalid_request_error";
}
