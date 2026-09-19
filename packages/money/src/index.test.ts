import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  applyBps,
  computeCommission,
  equals,
  format,
  money,
  parseToMinor,
  subtract,
  sum,
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
