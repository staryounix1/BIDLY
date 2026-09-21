import { describe, expect, it } from 'vitest';
import { computeCommission, tierBps, DEFAULT_SCHEDULE } from './apps/api/src/core/commission';

describe('tiered commission', () => {
  it('charges 15% for 100-450 MAD', () => {
    // 100 MAD = 10000 minor -> 15%
    expect(computeCommission({priceMinor:10000}, DEFAULT_SCHEDULE, null).commissionMinor).toBe(1500);
    // 400 MAD = 40000 minor -> 15% = 60 MAD
    expect(computeCommission({priceMinor:40000}, DEFAULT_SCHEDULE, null).commissionMinor).toBe(6000);
  });
  it('charges 20% above 450 MAD', () => {
    // 500 MAD -> 20% = 100 MAD
    expect(computeCommission({priceMinor:50000}, DEFAULT_SCHEDULE, null).commissionMinor).toBe(10000);
    // 800 MAD -> 20% = 160 MAD  <- the spec's example
    expect(computeCommission({priceMinor:80000}, DEFAULT_SCHEDULE, null).commissionMinor).toBe(16000);
  });
  it('boundary: exactly 450 MAD is still 15%', () => {
    expect(tierBps(45000, DEFAULT_SCHEDULE)).toBe(1500);
    expect(tierBps(45001, DEFAULT_SCHEDULE)).toBe(2000);
  });
  it('applies the scope rule minimum fee as a floor', () => {
    const rule = { id:'r1', model:'PERCENT', percent_bps:null, fixed_minor:null, min_fee_minor:'500', max_fee_minor:null };
    // 30 MAD job: 15% = 4.5 MAD, floored to the 5 MAD minimum
    expect(computeCommission({priceMinor:3000}, DEFAULT_SCHEDULE, rule).commissionMinor).toBe(500);
  });
  it('first job free', () => {
    expect(computeCommission({priceMinor:80000, isFirstJob:true}, DEFAULT_SCHEDULE, null).commissionMinor).toBe(0);
  });
  it('premium gets the reduced rate', () => {
    // 800 MAD at 20% would be 160; premium caps at 10% -> 80
    expect(computeCommission({priceMinor:80000, isPremium:true}, DEFAULT_SCHEDULE, null).commissionMinor).toBe(8000);
  });
});

describe('commission SQL against the real schema', () => {
  // `jobs` has no provider_user_id column (only provider_id); ownership must be
  // resolved through `providers`. A raw `where provider_user_id = $1` compiles
  // fine and crashes at runtime with 42703, which unit-testing the pure
  // calculator above cannot catch.
  it('isFirstJobFor resolves the provider user through providers, not jobs', async () => {
    const { isFirstJobFor } = await import('./apps/api/src/core/commission');
    let captured = '';
    // clientQuery() calls client.query() and takes rows[0].
    const fake = {
      query: async (sql: string) => { captured = sql; return { rows: [{ n: '0' }] }; },
    } as never;
    await isFirstJobFor(fake as never, 'u1');
    expect(captured).toMatch(/join providers/i);
    expect(captured).toMatch(/p\.user_id\s*=/i);
    expect(captured).not.toMatch(/jobs\s+where\s+provider_user_id/i);
  });
});
