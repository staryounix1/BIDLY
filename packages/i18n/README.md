# @bidly/i18n

Internationalisation foundation for BIDLY: locale metadata, RTL-aware text
direction, catalog-based translation, and locale-aware money/date/number
formatting.

- Launch locales: `ar` (RTL), `fr`, `en`.
- Market configuration (country, currency, timezone, locales) lives in the
  database `settings` table; this package consumes it, it does not hardcode it.
- Money is always passed in integer minor units; formatting divides at the
  presentation boundary only.
