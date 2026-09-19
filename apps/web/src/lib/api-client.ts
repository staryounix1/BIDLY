/**
 * API client foundation.
 *
 * One place that knows how to talk to the BIDLY API: base URL, JSON handling,
 * bearer token, and the platform's error envelope. Feature code calls typed
 * helpers rather than `fetch` directly, so auth, error shape, and later
 * retry/refresh behaviour are implemented once.
 *
 * The access token is kept in memory by default; the refresh token is the only
 * long-lived credential and belongs in an http-only cookie set by the server.
 */

export interface ApiErrorBody {
  success: false;
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, body: ApiErrorBody | null, fallbackMessage = 'Request failed') {
    super(body?.error?.message ?? fallbackMessage);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error?.code ?? 'UNKNOWN';
    this.details = body?.error?.details;
    this.requestId = body?.error?.requestId;
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken?: () => string | null | undefined;
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: unknown;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: () => string | null | undefined;
  private readonly onUnauthorized?: () => void;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.getAccessToken = options.getAccessToken ?? (() => null);
    this.onUnauthorized = options.onUnauthorized;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request<T>(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<ApiSuccess<T>> {
    const { json, headers, ...rest } = init;
    const token = this.getAccessToken();

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...rest,
      headers: {
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });

    if (response.status === 204) {
      return { success: true, data: undefined as T };
    }

    const body = (await response.json().catch(() => null)) as
      | ApiSuccess<T>
      | ApiErrorBody
      | null;

    if (!response.ok) {
      if (response.status === 401) this.onUnauthorized?.();
      throw new ApiError(response.status, body as ApiErrorBody | null);
    }
    return body as ApiSuccess<T>;
  }

  get<T>(path: string, init?: RequestInit) {
    return this.request<T>(path, { ...init, method: 'GET' });
  }

  post<T>(path: string, json?: unknown, init?: RequestInit) {
    return this.request<T>(path, { ...init, method: 'POST', json });
  }

  patch<T>(path: string, json?: unknown, init?: RequestInit) {
    return this.request<T>(path, { ...init, method: 'PATCH', json });
  }

  put<T>(path: string, json?: unknown, init?: RequestInit) {
    return this.request<T>(path, { ...init, method: 'PUT', json });
  }

  delete<T>(path: string, init?: RequestInit) {
    return this.request<T>(path, { ...init, method: 'DELETE' });
  }
}
