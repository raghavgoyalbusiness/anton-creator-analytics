/**
 * API client for the creator surface.
 *
 * The magic-link token is held in memory and sent in the Authorization header,
 * never as a query parameter, so it stays out of server access logs and out of
 * any Referer header. It is deliberately NOT written to localStorage: a shared
 * or borrowed phone should not carry a persistent credential.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * There is no token in JavaScript.
 *
 * The magic-link token is POSTed once to /session/exchange and swapped for an
 * httpOnly cookie the browser sends automatically. Nothing here holds a
 * credential, so an XSS in this app has nothing durable to steal.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      // Sends and accepts the session cookie.
      credentials: 'same-origin',
    });
  } catch {
    // Distinguish "your phone lost signal" from "the server said no", because
    // the creator's next action differs entirely.
    throw new ApiError(0, 'network_error', 'No connection. Check your signal and try again.');
  }

  if (!response.ok) {
    let code = 'unknown';
    let message = `Request failed (${response.status}).`;
    let details: unknown = null;
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; details?: unknown };
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      details = body.error?.details ?? null;
    } catch {
      /* non-JSON error body; keep the defaults */
    }
    throw new ApiError(response.status, code, message, details);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  /** Replaces a resource outright — the benchmark, for instance. */
  put: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T,>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
};

/** Swaps a single-use magic-link token for a session cookie. */
export async function exchangeToken(token: string): Promise<void> {
  await api.post('/api/creator/session/exchange', { token });
}

/** Uploads to a presigned URL. Goes straight to storage, not through our API. */
export async function putToPresigned(
  uploadUrl: string,
  blob: Blob,
  contentType: string,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: blob,
    // No credentials: this request goes to object storage, which must never
    // receive our session cookie.
    credentials: 'omit',
  });
  if (!response.ok) {
    throw new ApiError(response.status, 'upload_failed', 'The screenshot did not upload. Try again.');
  }
}
