import { describe, expect, it } from 'vitest';
import { formatMinor } from './payments-api';

describe('formatMinor', () => {
  it('formats a minor amount as a currency string', () => {
    const out = formatMinor(28000, 'MAD', 'en');
    expect(out).toContain('280');
  });

  it('renders a dash for null/undefined', () => {
    expect(formatMinor(null)).toBe('—');
    expect(formatMinor(undefined)).toBe('—');
  });

  it('formats zero', () => {
    expect(formatMinor(0, 'MAD', 'en')).toContain('0');
  });

  it('falls back to a plain string for an unknown currency code', () => {
    const out = formatMinor(1234, 'ZZZ', 'en');
    expect(out).toContain('12.34');
  });
});
