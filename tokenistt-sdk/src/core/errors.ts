/**
 * Error hierarchy mirroring (and extending) the OpenAI SDK's error set, plus
 * Tokenistt-specific errors for cost / budget control.
 */

export class TokenisttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenisttError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class APIError extends TokenisttError {
  readonly status: number | undefined;
  readonly headers: Record<string, string> | undefined;
  readonly error: unknown;
  readonly code: string | null | undefined;
  readonly requestId: string | undefined;

  constructor(
    status: number | undefined,
    error: unknown,
    message: string,
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.headers = headers;
    this.error = error;
    this.code = (error as any)?.code ?? (error as any)?.type ?? null;
    this.requestId =
      headers?.['x-request-id'] ?? (error as any)?.request_id ?? undefined;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class APIConnectionError extends TokenisttError {
  readonly cause: unknown;
  readonly requestId: string | undefined;

  constructor(opts: { message?: string; cause?: unknown; requestId?: string } = {}) {
    super(opts.message ?? 'Connection error.');
    this.name = 'APIConnectionError';
    this.cause = opts.cause;
    this.requestId = opts.requestId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class APIConnectionTimeoutError extends APIConnectionError {
  constructor(opts?: { message?: string; requestId?: string }) {
    super({
      message: opts?.message ?? 'Request timed out.',
      requestId: opts?.requestId,
    });
    this.name = 'APIConnectionTimeoutError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class APIUserAbortError extends TokenisttError {
  constructor(opts: { message?: string } = {}) {
    super(opts.message ?? 'Request was aborted by the user.');
    this.name = 'APIUserAbortError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class RateLimitError extends APIError {
  constructor(status: number, error: unknown, message: string, headers?: Record<string, string>) {
    super(status, error, message, headers);
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class BadRequestError extends APIError {
  constructor(status: number, error: unknown, message: string, headers?: Record<string, string>) {
    super(status, error, message, headers);
    this.name = 'BadRequestError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AuthenticationError extends APIError {
  constructor(status: number, error: unknown, message: string, headers?: Record<string, string>) {
    super(status, error, message, headers);
    this.name = 'AuthenticationError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InternalServerError extends APIError {
  constructor(status: number, error: unknown, message: string, headers?: Record<string, string>) {
    super(status, error, message, headers);
    this.name = 'InternalServerError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown before a request is sent when the hard budget has been exceeded. */
export class BudgetExceededError extends TokenisttError {
  readonly cumulativeCost: number;
  readonly limit: number;

  constructor(cumulativeCost: number, limit: number) {
    super(
      `Budget exceeded: cumulative spend $${cumulativeCost.toFixed(4)} >= hard limit $${limit.toFixed(4)}. Request blocked.`,
    );
    this.name = 'BudgetExceededError';
    this.cumulativeCost = cumulativeCost;
    this.limit = limit;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function makeErrorFromResponse(
  status: number,
  errorBody: unknown,
  headers?: Record<string, string>,
): APIError {
  const message = extractMessage(errorBody) ?? `Request failed with status ${status}`;
  if (status === 429) return new RateLimitError(status, errorBody, message, headers);
  if (status === 400) return new BadRequestError(status, errorBody, message, headers);
  if (status === 401) return new AuthenticationError(status, errorBody, message, headers);
  if (status >= 500) return new InternalServerError(status, errorBody, message, headers);
  return new APIError(status, errorBody, message, headers);
}

function extractMessage(body: unknown): string | undefined {
  if (!body) return undefined;
  if (typeof body === 'string') return body;
  if (typeof (body as any).message === 'string') return (body as any).message;
  if ((body as any).error?.message) return (body as any).error.message;
  return undefined;
}
