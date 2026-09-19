'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from './auth-provider';
import { useI18n } from './i18n-provider';

/**
 * Client-side route guard.
 *
 * This is a UX convenience only — it hides protected screens and redirects
 * signed-out visitors. It is NOT a security boundary: every protected API
 * call is authorised again on the server, which is the only place that
 * decides what a user may actually do.
 */
export function RequireAuth({
  children,
  roles,
}: {
  children: ReactNode;
  roles?: Array<'CUSTOMER' | 'PROVIDER' | 'ADMIN'>;
}) {
  const { user, ready } = useAuth();
  const { locale } = useI18n();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    if (!user) {
      router.replace(`/${locale}/login`);
      return;
    }
    if (roles && roles.length > 0 && !roles.includes(user.role)) {
      router.replace(`/${locale}`);
    }
  }, [ready, user, roles, router, locale]);

  if (!ready) return <div className="p-10 text-center opacity-60">…</div>;
  if (!user) return null;
  if (roles && roles.length > 0 && !roles.includes(user.role)) return null;
  return <>{children}</>;
}
