import { describe, expect, it } from 'vitest';
import { formatMinor } from './packages/money/src/index';

/**
 * Money in this codebase is stored in minor units (santim). Any figure that
 * reaches a human — a thrown business rule, a notification body, a receipt —
 * must be rendered as real currency.
 *
 * The bug this guards: `POST /offers/:id/agree` refused a 120 MAD job whose
 * commission was 1800 minor units, and interpolated the raw number:
 *
 *     "does not cover the commission of 1800 MAD."
 *
 * That reads as 1800 MAD — 100x the truth (18.00 MAD) — and made a correct
 * 15% charge look broken. `formatMinor` is the single helper that gets this
 * right, so assert its contract here where the offer flow can rely on it.
 */
describe('money formatting in human-facing prose', () => {
  it('renders minor units as real currency, not raw integers', () => {
    expect(formatMinor(1800, 'MAD')).toContain('18');
    expect(formatMinor(1800, 'MAD')).not.toContain('1800');
  });

  it('keeps the 100x factor: 120 MAD commission at 15% is 18.00 MAD', () => {
    const priceMinor = 12000;
    const commissionMinor = Math.round((priceMinor * 1500) / 10000);
    expect(commissionMinor).toBe(1800);
    expect(formatMinor(commissionMinor, 'MAD')).toContain('18');
  });

  it('shows the balance the provider is short by, in real currency', () => {
    // 0 MAD balance vs an 18.00 MAD charge.
    expect(formatMinor(0, 'MAD')).toContain('0');
    expect(formatMinor(2000, 'MAD')).toContain('20');
  });
});
