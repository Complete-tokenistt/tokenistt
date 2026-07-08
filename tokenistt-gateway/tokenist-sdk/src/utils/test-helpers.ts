import { APIError } from '../types/index.js';

export function parseError(body: string, status: number, headers: Record<string, string>): APIError {
  let errorData: Record<string, unknown> = {};
  
  try {
    if (body) {
      errorData = JSON.parse(body);
    }
  } catch {
    // Ignore parse errors
  }
  
  const message = (errorData.error as string) || 
                 (errorData.message as string) || 
                 `Request failed with status ${status}`;
  
  return new APIError(
    message,
    status,
    errorData.code as string | undefined,
    errorData.type as string | undefined,
    errorData.param as string | undefined,
    headers
  );
}

export function createMockResponse<T>(data: T, overrides?: Partial<Response>): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => data,
    text: async () => JSON.stringify(data),
    ...overrides,
  } as Response;
}

export function createErrorResponse(message: string, status: number): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ error: { message, status } }),
    text: async () => JSON.stringify({ error: { message, status } }),
  } as Response;
}
