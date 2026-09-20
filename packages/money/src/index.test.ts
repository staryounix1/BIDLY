import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  applyBps,
  computeCommission,
  computeTieredCommission,
  DEFAULT_COMMISSION_SCHEDULE,
  equals,
  format,
  money,
  parseToMinor,
  subtract,
  sum,
  tierForPrice,
  MoneyError,
} from './index.js';

describe('money', () => {
  it('constructs integer minor units', () => {
    expect(money(1500, 'MAD')).toEqual({ amountMinor: 1500, currency: 'MAD' });
  });

  it('rejects non-integer amounts', () => {
    expect(() => money(15.5, 'MAD')).toThrow(MoneyError);
  });

  it('rejects unknown currencies', () => {
    expect(() => money(100, 'ZZZ')).toThrow(MoneyError);
  });

  it('adds and subtracts', () => {
    const total = add(money(1000, 'MAD'), money(250, 'MAD'));
    expect(total.amountMinor).toBe(1250);
    expect(subtract(total, money(250, 'MAD')).amountMinor).toBe(1000);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(100, 'MAD'), money(100, 'EUR'))).toThrow(MoneyError);
  });

  it('sums a list', () => {
    expect(sum([money(100, 'MAD'), money(200, 'MAD'), money(300, 'MAD')], 'MAD').amountMinor).toBe(600);
  });

  it('applies basis points with half-up rounding', () => {
    expect(applyBps(money(10_000, 'MAD'), 1000).amountMinor).toBe(1000); // 10%
    expect(applyBps(money(333, 'MAD'), 1000).amountMinor).toBe(33); // 33.3 -> 33
    expect(applyBps(money(335, 'MAD'), 1000).amountMinor).toBe(34); // 33.5 -> 34
  });

  it('allocates without losing a minor unit', () => {
    const parts = allocate(money(100, 'MAD'), [1, 1, 1]);
    expect(parts.map((p) => p.amountMinor)).toEqual([34, 33, 33]);
    expect(sum(parts, 'MAD').amountMinor).toBe(100);
  });

  it('allocates proportionally and preserves the total', () => {
    const parts = allocate(money(1000, 'MAD'), [3, 7]);
    expect(sum(parts, 'MAD').amountMinor).toBe(1000);
    expect(parts[0]!.amountMinor).toBe(300);
    expect(parts[1]!.amountMinor).toBe(700);
  });

  it('compares values', () => {
    expect(equals(money(500, 'MAD'), money(500, 'MAD'))).toBe(true);
  });

  it('parses decimal input into minor units', () => {
    expect(parseToMinor('12.50', 'MAD')).toBe(1250);
    expect(parseToMinor(12.5, 'MAD')).toBe(1250);
  });

  it('formats for display', () => {
    expect(format(money(1250, 'MAD'), 'en')).toContain('12.50');
  });
});

describe('commission', () => {
  it('computes a percentage commission', () => {
    const result = computeCommission(money(10_000, 'MAD'), { model: 'PERCENT', percentBps: 1500, currency: 'MAD' });
    expect(result.commission.amountMinor).toBe(1500);
    expect(result.providerNet.amountMinor).toBe(8500);
    expect(result.effectiveBps).toBe(1500);
  });

  it('computes a fixed commission', () => {
    const result = computeCommission(money(10_000, 'MAD'), { model: 'FIXED', fixedMinor: 500, currency: 'MAD' });
    expect(result.commission.amountMinor).toBe(500);
    expect(result.providerNet.amountMinor).toBe(9500);
  });

  it('supports percent plus fixed', () => {
    const result = computeCommission(money(10_000, 'MAD'), {
      model: 'PERCENT_PLUS_FIXED',
      percentBps: 1000,
      fixedMinor: 200,
      currency: 'MAD',
    });
    expect(result.commission.amountMinor).toBe(1200);
  });

  it('clamps to a minimum fee', () => {
    const result = computeCommission(money(1_000, 'MAD'), {
      model: 'PERCENT',
      percentBps: 500,
      minFeeMinor: 100,
      currency: 'MAD',
    });
    expect(result.commission.amountMinor).toBe(100);
  });

  it('clamps to a maximum fee', () => {
    const result = computeCommission(money(100_000, 'MAD'), {
      model: 'PERCENT',
      percentBps: 2000,
      maxFeeMinor: 5000,
      currency: 'MAD',
    });
    expect(result.commission.amountMinor).toBe(5000);
  });

  it('never produces a negative provider net', () => {
    const result = computeCommission(money(100, 'MAD'), { model: 'FIXED', fixedMinor: 500, currency: 'MAD' });
    expect(result.providerNet.amountMinor).toBeGreaterThanOrEqual(0);
  });
});

describe('computeTieredCommission (Khdemli schedule)', () => {
  const price = (units: number) => money(units * 100, 'MAD');

  it('charges 15% under the 450 MAD band', () => {
    expect(computeTieredCommission({ price: price(100) }).commission.amountMinor).toBe(1500);
    expect(computeTieredCommission({ price: price(200) }).commission.amountMinor).toBe(3000);
    expect(computeTieredCommission({ price: price(400) }).commission.amountMinor).toBe(6000);
  });

  it('treats the 450 boundary as still 15%', () => {
    expect(computeTieredCommission({ price: price(450) }).commission.amountMinor).toBe(6750);
  });

  it('charges 20% from 500 MAD upwards', () => {
    expect(computeTieredCommission({ price: price(500) }).commission.amountMinor).toBe(10000);
    expect(computeTieredCommission({ price: price(1000) }).commission.amountMinor).toBe(20000);
  });

  it('charges 20% for prices above the 450 MAD band', () => {
    // The schedule is written as explicit bands: "up to 450 -> 15%",
    // "500 and above -> 20%". A price in the 451-499 gap therefore falls to
    // the open-ended top band. Change DEFAULT_COMMISSION_SCHEDULE (or the
    // `commission.tiers` setting) to move this boundary.
    expect(computeTieredCommission({ price: price(470) }).commission.amountMinor).toBe(9400);
  });

  it('reports the provider net and effective rate', () => {
    const result = computeTieredCommission({ price: price(400) });
    expect(result.providerNet.amountMinor).toBe(34000);
    expect(result.effectiveBps).toBe(1500);
    expect(result.tierIndex).toBe(0);
  });

  it('adds the SOS surcharge on top of the band rate', () => {
    const result = computeTieredCommission({ price: price(200), isSos: true });
    expect(result.effectiveBps).toBe(2000);
    expect(result.commission.amountMinor).toBe(4000);
  });

  it('applies the Premium rate instead of the band rate', () => {
    const result = computeTieredCommission({ price: price(1000), isPremium: true });
    expect(result.effectiveBps).toBe(1000);
    expect(result.commission.amountMinor).toBe(10000);
  });

  it('waives the fee entirely on a provider first job', () => {
    const result = computeTieredCommission({ price: price(400), isFirstJob: true });
    expect(result.commission.amountMinor).toBe(0);
    expect(result.providerNet.amountMinor).toBe(40000);
    expect(result.waived).toBe(true);
  });

  it('never exceeds the job price', () => {
    const schedule = { tiers: [{ upToMinor: null, bps: 20000 }] };
    const result = computeTieredCommission({ price: price(100), schedule });
    expect(result.commission.amountMinor).toBeLessThanOrEqual(10000);
  });

  it('falls back to the built-in schedule when tiers are empty', () => {
    const result = computeTieredCommission({ price: price(1000), schedule: { tiers: [] } });
    expect(result.commission.amountMinor).toBe(20000);
  });

  it('selects the open-ended band for very large prices', () => {
    const tiers = DEFAULT_COMMISSION_SCHEDULE.tiers;
    expect(tierForPrice(10_000_00, tiers)).toBe(1);
    expect(tierForPrice(45_000, tiers)).toBe(0);
  });
});
