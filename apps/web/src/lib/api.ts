/* eslint-disable @typescript-eslint/no-explicit-any -- callers name the response type; untyped calls are deliberate in simple pages */
/** Talks to the API through the same address (Next rewrites /api). Always sends the CSRF header. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public body?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: {
      'x-requested-with': 'freight',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok && !(data && typeof data === 'object' && 'result' in data)) {
    throw new ApiError(
      res.status,
      data?.error ?? 'error',
      data?.message ?? res.statusText,
      data?.details,
      data,
    );
  }
  return data as T;
}

export const post = <T = any>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body });
