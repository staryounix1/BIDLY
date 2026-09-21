import type { PoolClient } from 'pg';
import { clientQuery, queryOne } from '../db/pool.js';

/**
 * Commission resolution.
 *
 * Two sources of truth exist and both must be honoured:
 *
 *  1. `commission_rules` — scoped rows (SERVICE > CATEGORY > GLOBAL) with a
 *     percent, optional fixed part and min/max caps. This is the per-scope
 *     override an operator tunes from the admin panel.
 *  2. `settings['commission.tiers']` — the *tiered* schedule the product spec
 *     asks for: 15% up to 450 MAD, 20% above it, plus SOS extra, a reduced
 *     Premium rate and first-job-free.
 *
 * Historically only (1) was read, so every job was charged the flat 15% global
 * rule and the tier table was dead configuration. `resolveCommission` now walks
 * the tiers and layers the flags on top.
 */

export interface CommissionTier {
  upToMinor: number | null;
  bps: number;
}

export interface CommissionSchedule {
  tiers: CommissionTier[];
  sosExtraBps: number;
  premiumBps: number;
  firstJobFree: boolean;
}

export const DEFAULT_SCHEDULE: CommissionSchedule = {
  tiers: [
    { upToMinor: 45000, bps: 1500 },
    { upToMinor: null, bps: 2000 },
  ],
  sosExtraBps: 500,
  premiumBps: 1000,
  firstJobFree: true,
};

export interface CommissionRuleRow {
  id: string;
  model: string;
  percent_bps: number | null;
  fixed_minor: string | number | null;
  min_fee_minor: string | number | null;
  max_fee_minor: string | number | null;
}

export interface CommissionInput {
  priceMinor: number;
  /** Business rule: only one of these may be set. */
  isSos?: boolean;
  isPremium?: boolean;
  /** The provider has never had a completed job. */
  isFirstJob?: boolean;
  /** Which flags the operator has switched on. */
  flags?: { sos?: boolean; premium?: boolean; firstJobFree?: boolean };
}

/** Walk the tier table: first tier whose cap the price fits under wins. */
export function tierBps(priceMinor: number, schedule: CommissionSchedule): number | null {
  for (const tier of schedule.tiers) {
    if (tier.upToMinor == null || priceMinor <= tier.upToMinor) return tier.bps;
  }
  const last = schedule.tiers[schedule.tiers.length - 1];
  return last ? last.bps : null;
}

export interface ResolvedCommission {
  commissionMinor: number;
  providerNetMinor: number;
  /** Plain-language trail, stored on the job for support and audits. */
  basis: string;
  bps: number;
  ruleId: string | null;
  snapshot: Record<string, unknown>;
}

/**
 * Pure calculation, split out so it can be tested without a database.
 *
 * `rulePercentBps` is a per-scope override and wins over the tier table, because
 * an operator who configured a specific category did so on purpose.
 */
export function computeCommission(
  input: CommissionInput,
  schedule: CommissionSchedule,
  rule: CommissionRuleRow | null,
): ResolvedCommission {
  const price = Math.max(0, Math.round(input.priceMinor));
  const parts: string[] = [];

  let bps: number;
  if (rule?.percent_bps != null) {
    bps = rule.percent_bps;
    parts.push(`scope rule ${(bps / 100).toFixed(2)}%`);
  } else {
    const tier = tierBps(price, schedule);
    bps = tier ?? 1500;
    parts.push(`tier ${(bps / 100).toFixed(2)}%`);
  }

  const flags = input.flags ?? {};

  // First completed job is commission-free (spec: first_job_free).
  if (input.isFirstJob && schedule.firstJobFree && flags.firstJobFree !== false) {
    return {
      commissionMinor: 0,
      providerNetMinor: price,
      basis: 'first job free',
      bps: 0,
      ruleId: rule?.id ?? null,
      snapshot: { bps: 0, reason: 'FIRST_JOB_FREE', priceMinor: price },
    };
  }

  // Premium members get the reduced rate instead of the regular one.
  if (input.isPremium && flags.premium !== false) {
    bps = Math.min(bps, schedule.premiumBps);
    parts.push('premium discount');
  }

  // SOS carries a surcharge (spec: higher commission, editable).
  if (input.isSos && flags.sos !== false) {
    bps += schedule.sosExtraBps;
    parts.push('SOS surcharge');
  }

  let commissionMinor = Math.round((price * bps) / 10000);

  if (rule?.fixed_minor) {
    commissionMinor += Number(rule.fixed_minor);
    parts.push('plus fixed fee');
  }
  if (rule?.min_fee_minor != null) commissionMinor = Math.max(commissionMinor, Number(rule.min_fee_minor));
  if (rule?.max_fee_minor != null) commissionMinor = Math.min(commissionMinor, Number(rule.max_fee_minor));

  // Never take more than the job is worth.
  commissionMinor = Math.min(Math.max(commissionMinor, 0), price);

  return {
    commissionMinor,
    providerNetMinor: price - commissionMinor,
    basis: parts.join(' + '),
    bps,
    ruleId: rule?.id ?? null,
    snapshot: {
      bps,
      basis: parts.join(' + '),
      priceMinor: price,
      tiers: schedule.tiers,
      isSos: Boolean(input.isSos),
      isPremium: Boolean(input.isPremium),
      isFirstJob: Boolean(input.isFirstJob),
    },
  };
}

export async function loadSchedule(client?: PoolClient): Promise<CommissionSchedule> {
  const c = client ? clientQuery(client) : null;
  const row = c
    ? await c.one<{ value: unknown }>(`select value from settings where key = 'commission.tiers'`)
    : await queryOne<{ value: unknown }>(`select value from settings where key = 'commission.tiers'`);
  if (!row?.value) return DEFAULT_SCHEDULE;
  const value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  const v = value as Partial<CommissionSchedule>;
  return {
    tiers: Array.isArray(v.tiers) && v.tiers.length ? v.tiers : DEFAULT_SCHEDULE.tiers,
    sosExtraBps: Number(v.sosExtraBps ?? DEFAULT_SCHEDULE.sosExtraBps),
    premiumBps: Number(v.premiumBps ?? DEFAULT_SCHEDULE.premiumBps),
    firstJobFree: v.firstJobFree ?? DEFAULT_SCHEDULE.firstJobFree,
  };
}

/** SERVICE override > CATEGORY override > GLOBAL. */
export async function loadRule(
  client: PoolClient,
  serviceId: string | null,
  requestId: string,
): Promise<CommissionRuleRow | null> {
  return clientQuery(client).one<CommissionRuleRow>(
    `select id, model, percent_bps, fixed_minor, min_fee_minor, max_fee_minor
     from commission_rules
     where is_active and effective_from <= now() and (effective_to is null or effective_to > now())
       and (
         (service_id = $1) or
         (service_id is null and category_id = (select category_id from requests where id = $2)) or
         (service_id is null and category_id is null and scope = 'GLOBAL')
       )
     order by
       case scope when 'SERVICE' then 1 when 'CATEGORY' then 2 when 'GLOBAL' then 3 else 4 end,
       priority desc
     limit 1`,
    [serviceId, requestId],
  );
}

/** A provider is "new" until their first job completes. */
export async function isFirstJobFor(client: PoolClient, providerUserId: string): Promise<boolean> {
  // `jobs` stores provider_id (the provider row), not a user id, so the
  // ownership test has to go through `providers`.
  const row = await clientQuery(client).one<{ n: string }>(
    `select count(*)::text as n
       from jobs j
       join providers p on p.id = j.provider_id
      where p.user_id = $1 and j.status = 'COMPLETED'`,
    [providerUserId],
  );
  return Number(row?.n ?? 0) === 0;
}

export async function resolveCommission(
  client: PoolClient,
  input: CommissionInput & { serviceId: string | null; requestId: string; providerUserId: string },
): Promise<ResolvedCommission> {
  const [schedule, rule, isFirstJob] = await Promise.all([
    loadSchedule(client),
    loadRule(client, input.serviceId, input.requestId),
    input.isFirstJob ?? isFirstJobFor(client, input.providerUserId),
  ]);
  return computeCommission({ ...input, isFirstJob }, schedule, rule);
}

