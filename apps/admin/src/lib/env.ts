/**
 * Public runtime configuration for the web app.
 *
 * Only `NEXT_PUBLIC_*` values belong here: they are inlined into the browser
 * bundle at build time. Server-only secrets are read directly from
 * `process.env` inside server components or route handlers, never here.
 */

export const publicEnv = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
  defaultCurrency: process.env.NEXT_PUBLIC_DEFAULT_CURRENCY ?? 'MAD',
  defaultCountry: process.env.NEXT_PUBLIC_DEFAULT_COUNTRY ?? 'MA',
  demoMode: process.env.NEXT_PUBLIC_DEMO_MODE === 'true',
} as const;
