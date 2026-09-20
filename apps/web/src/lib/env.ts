/**
 * Public runtime configuration for the web app.
 *
 * Only `NEXT_PUBLIC_*` values belong here: they are inlined into the browser
 * bundle at build time. Server-only secrets are read directly from
 * `process.env` inside server components or route handlers, never here.
 */

/**
 * Resolve the API origin.
 *
 * In the browser the app normally talks to `NEXT_PUBLIC_API_URL`. On Vercel that
 * value is the production origin, but a preview deployment is a *different*
 * origin, so an absolute cross-origin call is rejected by the API's CORS policy.
 * Preview deployments also proxy `/api/*` to the API (see `vercel.json`), so when
 * the configured origin differs from the page origin we fall back to a relative
 * base and let that same-origin proxy carry the request. This keeps one build
 * working on any Vercel origin without loosening server CORS.
 */
function resolveApiUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
  if (typeof window === 'undefined') return configured;
  try {
    const target = new URL(configured, window.location.href);
    if (target.origin !== window.location.origin) return '';
  } catch {
    return configured;
  }
  return configured;
}

export const publicEnv = {
  apiUrl: resolveApiUrl(),
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
  defaultCurrency: process.env.NEXT_PUBLIC_DEFAULT_CURRENCY ?? 'MAD',
  defaultCountry: process.env.NEXT_PUBLIC_DEFAULT_COUNTRY ?? 'MA',
  demoMode: process.env.NEXT_PUBLIC_DEMO_MODE === 'true',
} as const;
