/**
 * Money arithmetic in integer minor units.
 *
 * Rules:
 *  - Money is ALWAYS an integer count of minor units (centimes, cents, ...).
 *  - Never use floating point for money. Percentages are basis points (bps).
 *  - Every operation validates currency consistency.
 */

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export const CURRENCY_MINOR_UNITS: Record<string, number> = {
  MAD: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  XOF: 0,
  XAF: 0,
  JPY: 0,
  KRW: 0,
  BHD: 3,
  KWD: 3,
};

export function minorUnitsFor(currency: string): number {
  const units = CURRENCY_MINOR_UNITS[currency.toUpperCase()];
  if (units === undefined) {
    throw new MoneyError(`Unknown currency: ${currency}`);
  }
  return units;
}

export function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${label} must be an integer number of minor units, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} exceeds safe integer range: ${value}`);
  }
}

export function money(amountMinor: number, currency: string): Money {
  assertInteger(amountMinor, 'amountMinor');
  const code = currency.toUpperCase();
  // Validate at construction so an invalid currency fails here, with a clear
  // message, rather than much later inside an arithmetic helper.
  minorUnitsFor(code);
  return Object.freeze({ amountMinor, currency: code });
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function isZero(a: Money): boolean {
  return a.amountMinor === 0;
}

export function isNegative(a: Money): boolean {
  return a.amountMinor < 0;
}

export function isPositive(a: Money): boolean {
  return a.amountMinor > 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function greaterThan(a: Money, b: Money): boolean {
  assertSameCurrency(a, b);
  return a.amountMinor > b.amountMinor;
}

export function lessThan(a: Money, b: Money): boolean {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor === b.amountMinor) return 0;
  return a.amountMinor > b.amountMinor ? 1 : -1;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

export function sum(amounts: Money[], currency: string): Money {
  return amounts.reduce((acc, m) => add(acc, m), money(0, currency));
}

/**
 * Apply a basis-point rate with round-half-away-from-zero (banker-neutral,
 * deterministic across platforms). bps 1500 = 15%.
 */
export function applyBps(amount: Money, bps: number): Money {
  assertInteger(bps, 'bps');
  if (bps < 0) throw new MoneyError('bps must be non-negative');
  const numerator = amount.amountMinor * bps;
  const denominator = 10_000;
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  const quotient = Math.floor(abs / denominator);
  const remainder = abs % denominator;
  const rounded = remainder * 2 >= denominator ? quotient + 1 : quotient;
  return money(sign * rounded, amount.currency);
}

/**
 * Split a total by integer weights without losing or creating a single minor
 * unit (largest-remainder method). Used for shared/partial money movements.
 */
export function allocate(total: Money, weights: number[]): Money[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) throw new MoneyError('Weights must sum to a positive number');
  if (weights.some((w) => w < 0)) throw new MoneyError('Weights must be non-negative');

  const sign = total.amountMinor < 0 ? -1 : 1;
  const absTotal = Math.abs(total.amountMinor);

  const raw = weights.map((w) => (absTotal * w) / totalWeight);
  const floored = raw.map((v) => Math.floor(v));
  let remainder = absTotal - floored.reduce((a, b) => a + b, 0);

  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);

  const result = [...floored];
  for (let k = 0; k < order.length && remainder > 0; k++) {
    const target = order[k];
    if (target) {
      result[target.i] = (result[target.i] ?? 0) + 1;
      remainder -= 1;
    }
  }
  return result.map((v) => money(sign * v, total.currency));
}

// ---------------------------------------------------------------------
// Commission calculation
// ---------------------------------------------------------------------

export interface CommissionRule {
  model: 'PERCENT' | 'FIXED' | 'PERCENT_PLUS_FIXED';
  percentBps?: number | null;
  fixedMinor?: number | null;
  minFeeMinor?: number | null;
  maxFeeMinor?: number | null;
  currency: string;
}

/**
 * A stored commission rule, as read from `commission_rules`. Adds the scope
 * and priority columns used to select the winning rule for a given job.
 */
export interface StoredCommissionRule extends CommissionRule {
  id: string;
  categoryId?: string | null;
  subcategoryId?: string | null;
  serviceId?: string | null;
  providerId?: string | null;
  countryCode?: string | null;
  scope?: string;
  priority?: number;
}

export interface CommissionResult {
  commission: Money;
  providerNet: Money;
  effectiveBps: number;
  ruleModel: CommissionRule['model'];
}

/**
 * Compute the platform commission for a job. Deterministic and pure so it can
 * be unit-tested and snapshotted onto the job row at accept time.
 */
export function computeCommission(price: Money, rule: CommissionRule): CommissionResult {
  if (price.currency !== rule.currency) {
    throw new MoneyError(
      `Commission rule currency ${rule.currency} does not match price currency ${price.currency}`,
    );
  }
  let feeMinor = 0;

  switch (rule.model) {
    case 'PERCENT': {
      feeMinor = applyBps(price, rule.percentBps ?? 0).amountMinor;
      break;
    }
    case 'FIXED': {
      feeMinor = rule.fixedMinor ?? 0;
      break;
    }
    case 'PERCENT_PLUS_FIXED': {
      feeMinor =
        applyBps(price, rule.percentBps ?? 0).amountMinor + (rule.fixedMinor ?? 0);
      break;
    }
  }

  if (rule.minFeeMinor != null && feeMinor < rule.minFeeMinor) feeMinor = rule.minFeeMinor;
  if (rule.maxFeeMinor != null && feeMinor > rule.maxFeeMinor) feeMinor = rule.maxFeeMinor;
  if (feeMinor > price.amountMinor) feeMinor = price.amountMinor;
  if (feeMinor < 0) feeMinor = 0;

  const commission = money(feeMinor, price.currency);
  const providerNet = subtract(price, commission);
  const effectiveBps =
    price.amountMinor === 0 ? 0 : Math.round((feeMinor * 10_000) / price.amountMinor);

  return { commission, providerNet, effectiveBps, ruleModel: rule.model };
}

// ---------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------

export function format(amount: Money, locale = 'en', symbol?: string): string {
  const units = minorUnitsFor(amount.currency);
  const value = amount.amountMinor / 10 ** units;
  const formatted = new Intl.NumberFormat(locale, {
    style: symbol ? 'decimal' : 'currency',
    currency: amount.currency,
    minimumFractionDigits: units,
    maximumFractionDigits: units,
  }).format(value);
  return symbol ? `${formatted} ${symbol}` : formatted;
}

export function formatMinor(
  amountMinor: number,
  currency: string,
  locale = 'en',
  symbol?: string,
): string {
  return format(money(amountMinor, currency), locale, symbol);
}

export function parseToMinor(input: string | number, currency: string): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError('Amount must be finite');
    const units = minorUnitsFor(currency);
    return Math.round(input * 10 ** units);
  }
  const cleaned = input.replace(/[^\d.,-]/g, '').replace(',', '.');
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) throw new MoneyError(`Cannot parse amount: ${input}`);
  const units = minorUnitsFor(currency);
  return Math.round(parsed * 10 ** units);
}
