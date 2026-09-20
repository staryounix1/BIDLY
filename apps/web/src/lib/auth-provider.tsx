'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { authApi, setUnauthorizedHandler, tokenStore, type AuthUser, type Profile, type RegisterResponse } from './auth-api';

/**
 * Client authentication state.
 *
 * Responsibilities:
 *  - restore the session on first load (refresh token -> new access token -> /me)
 *  - expose signIn / signUp / signOut / reload to the UI
 *  - refresh the access token once when a request 401s, then retry that request
 *  - keep `user` in sync with the backend and clear it on a dead session
 *
 * The backend is always the source of truth: this state mirrors it, it never
 * authorises anything on its own. Protected pages re-check with the API.
 */

interface AuthContextValue {
  user: AuthUser | null;
  profile: Profile | null;
  ready: boolean;
  isAuthenticated: boolean;
  hasRole: (...roles: Array<AuthUser['role']>) => boolean;
  signIn: (identifier: string, password: string) => Promise<AuthUser>;
  signUp: (payload: Parameters<typeof authApi.register>[0]) => Promise<RegisterResponse>;
  signOut: () => Promise<void>;
  reload: () => Promise<void>;
  saveProfile: (patch: Record<string, unknown>) => Promise<Profile>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [ready, setReady] = useState(false);

  // Serialise refreshes so parallel 401s don't each spawn a rotation.
  const refreshing = useRef<Promise<AuthUser | null> | null>(null);

  const loadProfile = useCallback(async () => {
    try {
      setProfile(await authApi.getProfile());
    } catch {
      setProfile(null);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    if (!tokenStore.access() && !tokenStore.refresh()) {
      setUser(null);
      setProfile(null);
      return;
    }

    const session = await authApi.refresh();
    if (!session) {
      tokenStore.clear();
      setUser(null);
      setProfile(null);
      return;
    }
    setUser(session.user);
    await loadProfile();
  }, [loadProfile]);

  // Restore session once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await bootstrap();
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrap]);

  // On 401: try a single refresh; if that fails, treat the session as dead.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!refreshing.current) {
        refreshing.current = authApi
          .refresh()
          .then((session) => session?.user ?? null)
          .finally(() => {
            refreshing.current = null;
          });
      }
      void refreshing.current.then((u) => {
        if (!u) {
          setUser(null);
          setProfile(null);
        }
      });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const reload = useCallback(async () => {
    const fresh = await authApi.me();
    setUser(fresh);
    await loadProfile();
  }, [loadProfile]);

  const signIn = useCallback(
    async (identifier: string, password: string) => {
      const session = await authApi.login(identifier, password);
      setUser(session.user);
      await loadProfile();
      return session.user;
    },
    [loadProfile],
  );

  const signUp = useCallback(
    async (payload: Parameters<typeof authApi.register>[0]) => {
      const result = await authApi.register(payload);

      // Sign the new account in on the spot. Registration used to drop the user
      // back on the login page to type the same credentials again, which is a
      // pointless step: the account is active the moment it is created (unless
      // the email check is on, in which case the guard still lets them in and
      // asks for the code). Creating a session here means "sign up" really
      // takes you into the product.
      try {
        const session = await authApi.login(payload.email, payload.password);
        setUser(session.user);
        await loadProfile();
      } catch {
        // Login should not fail right after a successful register (the account
        // was just created with this exact password). If it somehow does, the
        // caller still gets `verificationRequired` and can route to login.
      }

      return result;
    },
    [loadProfile],
  );

  const signOut = useCallback(async () => {
    await authApi.logout();
    setUser(null);
    setProfile(null);
  }, []);

  const saveProfile = useCallback(async (patch: Record<string, unknown>) => {
    const updated = await authApi.updateProfile(patch);
    setProfile(updated);
    return updated;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      profile,
      ready,
      isAuthenticated: user != null,
      hasRole: (...roles: Array<AuthUser['role']>) => user != null && roles.includes(user.role),
      signIn,
      signUp,
      signOut,
      reload,
      saveProfile,
    }),
    [user, profile, ready, signIn, signUp, signOut, reload, saveProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider.');
  return ctx;
}
