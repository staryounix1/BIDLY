import { ApiClient, ApiError } from './api-client';
import { publicEnv } from './env';

/**
 * Authentication API surface.
 *
 * One module that owns every call to /auth and /users/me, plus the single
 * ApiClient instance the rest of the app shares. The client reads the current
 * access token from storage on each request and, on a 401, hands control to
 * the refresh routine registered by the AuthProvider (see `setRefreshHandler`).
 */

const API_BASE = `${publicEnv.apiUrl.replace(/\/$/, '')}/api/v1`;

// --- token storage ----------------------------------------------------
// The access token is short-lived; the refresh token is the long-lived
// credential. Both live in localStorage so a page refresh keeps the session.
// (A production hardening step is to move the refresh token to an http-only
// cookie issued by the server; the client code already tolerates that.)

const ACCESS_KEY = 'bidly.accessToken';
const REFRESH_KEY = 'bidly.refreshToken';

export const tokenStore = {
  access(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(ACCESS_KEY);
  },
  refresh(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(REFRESH_KEY);
  },
  set(accessToken: string, refreshToken: string): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(ACCESS_KEY, accessToken);
    window.localStorage.setItem(REFRESH_KEY, refreshToken);
  },
  clear(): void {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(ACCESS_KEY);
    window.localStorage.removeItem(REFRESH_KEY);
  },
};

// --- shared client with automatic refresh -----------------------------

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export const api = new ApiClient({
  baseUrl: API_BASE,
  getAccessToken: () => tokenStore.access(),
  onUnauthorized: () => {
    // The provider decides whether to attempt a refresh and retry, or to
    // clear the session and redirect. Kept out of the client so the client
    // stays free of React/router concerns.
    unauthorizedHandler?.();
  },
});

// --- types ------------------------------------------------------------

export interface AuthUser {
  id: string;
  email: string | null;
  phone: string | null;
  role: 'CUSTOMER' | 'PROVIDER' | 'ADMIN';
  status: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  providerId?: string | null;
  adminRole?: string | null;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface Profile {
  id: string;
  user_id: string;
  full_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  preferred_locale: string;
  preferred_currency: string;
  date_of_birth?: string | null;
  gender?: string | null;
  email: string | null;
  phone: string | null;
  role: AuthUser['role'];
  status: string;
  email_verified_at: string | null;
  phone_verified_at: string | null;
}

// --- calls ------------------------------------------------------------

export interface RegisterPayload {
  email: string;
  password: string;
  fullName?: string;
  phone?: string;
  locale?: string;
  role?: 'CUSTOMER' | 'PROVIDER';
}

export interface RegisterResponse {
  user: AuthUser;
  verificationRequired: boolean;
  message: string;
}

export const authApi = {
  async register(payload: RegisterPayload): Promise<RegisterResponse> {
    const res = await api.post<RegisterResponse>('/register', payload);
    return res.data;
  },

  async login(identifier: string, password: string): Promise<AuthSession> {
    const res = await api.post<AuthSession>('/login', { identifier, password });
    tokenStore.set(res.data.accessToken, res.data.refreshToken);
    return res.data;
  },

  async refresh(): Promise<AuthSession | null> {
    const refreshToken = tokenStore.refresh();
    if (!refreshToken) return null;
    try {
      const res = await api.post<AuthSession>('/refresh', { refreshToken });
      tokenStore.set(res.data.accessToken, res.data.refreshToken);
      return res.data;
    } catch {
      tokenStore.clear();
      return null;
    }
  },

  async logout(): Promise<void> {
    try {
      await api.post('/logout');
    } catch {
      // Even if the server call fails, drop local credentials.
    } finally {
      tokenStore.clear();
    }
  },

  async me(): Promise<AuthUser> {
    const res = await api.get<AuthUser & { admin_role: string | null }>('/me');
    return res.data;
  },

  async getProfile(): Promise<Profile> {
    const res = await api.get<Profile>('/users/me/profile');
    return res.data;
  },

  async updateProfile(patch: Record<string, unknown>): Promise<Profile> {
    const res = await api.patch<Profile>('/users/me/profile', patch);
    return res.data;
  },

  async verifyEmail(code: string, email?: string): Promise<void> {
    await api.post('/verify-email', email ? { code, email } : { code });
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await api.post('/password/change', { currentPassword, newPassword });
  },
};

export { ApiError };
