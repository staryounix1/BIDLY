import type { FastifyInstance } from 'fastify';
import { forbidden, notFound, businessRule, conflict } from '../../core/errors.js';
import { clientQuery, queryMany, queryOne, transaction } from '../../db/pool.js';
import { LOG_EVENTS, logEvent } from '../../core/logger.js';

/**
 * /referrals — invite codes and wallet rewards.
 *
 * Every user has one code (`khdemli_ensure_referral_code` generates it lazily).
 * A new user who signs up with someone's code creates a PENDING referral; the
 * rewards are only paid once the referee *completes their first job*, so an
 * account farm cannot mint wallet credit without real work happening.
 *
 * Rewards are paid as wallet ledger rows, never by touching a balance directly:
 * the wallet triggers derive `balance_after_minor` and move `available_minor`.
 */

async function flagEnabled(key: string): Promise<boolean> {
  const row = await queryOne<{ enabled: boolean }>(
    'select enabled from feature_flags where key = $1',
    [key],
  );
  return Boolean(row?.enabled);
}

async function settingMinor(key: string): Promise<number | null> {
  const row = await queryOne<{ value: unknown }>('select value from settings where key = $1', [key]);
  if (row?.value == null) return null;
  const raw = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
  const n = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Credit a wallet through the ledger. Returns the new balance. */
async function creditWallet(
  c: ReturnType<typeof clientQuery>,
  userId: string,
  amountMinor: number,
  description: string,
): Promise<void> {
  if (amountMinor <= 0) return;
  const wallet = await c.one<{ id: string; available_minor: string; currency: string }>(
    `select id, available_minor, currency from wallets
      where owner_type = 'PROVIDER' and owner_id = $1
      order by created_at limit 1 for update`,
    [userId],
  );
  // No wallet yet: create one so the reward is not silently lost.
  const w = wallet ?? await c.one<{ id: string; available_minor: string; currency: string }>(
    `insert into wallets (owner_type, owner_id, currency, available_minor)
     values ('PROVIDER', $1, 'MAD', 0)
     returning id, available_minor, currency`,
    [userId],
  );
  if (!w) return;

  // `trg_wallet_txn_validate` requires balance_after_minor to equal the
  // post-movement balance; the AFTER trigger then applies the delta itself.
  const after = Number(w.available_minor) + amountMinor;
  await c.query(
    `insert into wallet_transactions
       (wallet_id, direction, type, amount_minor, currency, balance_after_minor, description)
     values ($1, 'CREDIT', 'BONUS', $2, $3, $4, $5)`,
    [w.id, amountMinor, w.currency, after, description],
  );
}

export async function registerReferralRoutes(app: FastifyInstance): Promise<void> {
  // ---- My code + who I invited -------------------------------------------
  app.get('/referrals/me', {
    preHandler: [app.authenticate],
    schema: { tags: ['referrals'], summary: 'My invite code and referrals', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const auth = request.auth!;
    const enabled = await flagEnabled('referrals');

    const code = await queryOne<{ code: string }>(
      `select khdemli_ensure_referral_code($1) as code`,
      [auth.userId],
    );

    const rows = enabled
      ? await queryMany<{
          id: string; status: string; created_at: string; rewarded_at: string | null;
          referrer_reward_minor: string; referee_reward_minor: string;
          referee_email: string | null;
        }>(
          `select r.id, r.status::text, r.created_at, r.rewarded_at,
                  r.referrer_reward_minor, r.referee_reward_minor,
                  u.email as referee_email
             from referrals r
             left join users u on u.id = r.referee_id
            where r.referrer_id = $1
            order by r.created_at desc limit 50`,
          [auth.userId],
        )
      : [];

    // Reward amounts are read live so an admin change shows up immediately.
    const [referrerReward, refereeReward] = await Promise.all([
      settingMinor('referral.referrer_reward_minor'),
      settingMinor('referral.referee_reward_minor'),
    ]);

    const rewarded = rows.filter((r) => r.status === 'REWARDED').length;
    const earnedMinor = rows
      .filter((r) => r.status === 'REWARDED')
      .reduce((n, r) => n + Number(r.referrer_reward_minor ?? 0), 0);

    return reply.send({
      success: true,
      data: {
        enabled,
        code: code?.code ?? null,
        referrals: rows,
        rewarded,
        earnedMinor,
        rewardMinor: { referrer: referrerReward, referee: refereeReward },
      },
    });
  });

  // ---- Claim someone else's code -----------------------------------------
  app.post('/referrals/claim', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['referrals'], summary: 'Apply an invite code', security: [{ bearerAuth: [] }],
      body: {
        type: 'object', required: ['code'], additionalProperties: false,
        properties: { code: { type: 'string', minLength: 4, maxLength: 16 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { code } = request.body as { code: string };

    if (!(await flagEnabled('referrals'))) throw businessRule('Referrals are not available right now.');

    const result = await transaction(async (client) => {
      const c = clientQuery(client);

      const owner = await c.one<{ user_id: string; is_active: boolean }>(
        `select user_id, is_active from referral_codes where upper(code) = upper($1) for update`,
        [code.trim()],
      );
      if (!owner || !owner.is_active) throw notFound('Invite code');
      if (owner.user_id === auth.userId) throw businessRule('You cannot use your own invite code.');

      // Once per referee: a second claim would double-pay on first completion.
      const existing = await c.one<{ id: string }>(
        `select id from referrals where referee_id = $1`,
        [auth.userId],
      );
      if (existing) throw conflict('You have already used an invite code.');

      // Only brand-new accounts: an established user is not a "referral".
      const done = await c.one<{ n: string }>(
        `select count(*)::text as n from jobs where customer_id = $1
            and status in ('COMPLETED','PAID')`,
        [auth.userId],
      );
      if (Number(done?.n ?? 0) > 0) {
        throw businessRule('Invite codes can only be used before your first completed job.');
      }

      const [referrerReward, refereeReward] = await Promise.all([
        settingMinor('referral.referrer_reward_minor'),
        settingMinor('referral.referee_reward_minor'),
      ]);

      const referral = await c.one<{ id: string }>(
        `insert into referrals (referrer_id, referee_id, code, status,
                                referrer_reward_minor, referee_reward_minor, currency)
         values ($1, $2, $3, 'PENDING', $4, $5, 'MAD')
         returning id`,
        [owner.user_id, auth.userId, code.trim().toUpperCase(), referrerReward ?? 0, refereeReward ?? 0],
      );

      await c.query(`update referral_codes set uses_count = uses_count + 1 where code = upper($1)`, [code.trim()]);
      return referral;
    });

    logEvent(LOG_EVENTS.REFERRAL_CLAIMED, { userId: auth.userId, referralId: result?.id });
    return reply.status(201).send({ success: true, data: result });
  });

  // ---- Who invited me ----------------------------------------------------
  app.get('/referrals/mine-as-referee', {
    preHandler: [app.authenticate],
    schema: { tags: ['referrals'], summary: 'The referral I was invited through', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const auth = request.auth!;
    const row = await queryOne<{ id: string; status: string; code: string }>(
      `select id, status::text, code from referrals where referee_id = $1`,
      [auth.userId],
    );
    return reply.send({ success: true, data: row });
  });
}

/**
 * Called when a job completes: pay both sides of a PENDING referral once.
 *
 * Kept out of the route file so `jobs.routes.ts` can call it directly inside
 * its own transaction. Idempotent: the row is flipped to REWARDED, and a second
 * call finds no PENDING row.
 */
export async function releaseReferralReward(
  c: ReturnType<typeof clientQuery>,
  refereeUserId: string,
  jobId: string,
): Promise<boolean> {
  if (!(await flagEnabled('referrals'))) return false;

  const ref = await c.one<{
    id: string; referrer_id: string; referee_id: string;
    referrer_reward_minor: string; referee_reward_minor: string;
  }>(
    `select id, referrer_id, referee_id, referrer_reward_minor, referee_reward_minor
       from referrals
      where referee_id = $1 and status = 'PENDING'
      for update`,
    [refereeUserId],
  );
  if (!ref) return false;

  await creditWallet(c, ref.referee_id, Number(ref.referee_reward_minor ?? 0), 'Referral bonus (welcome)');
  await creditWallet(c, ref.referrer_id, Number(ref.referrer_reward_minor ?? 0), 'Referral bonus (invite)');

  await c.query(
    `update referrals set status = 'REWARDED', rewarded_at = now(), qualifying_job_id = $2, updated_at = now()
      where id = $1`,
    [ref.id, jobId],
  );
  logEvent(LOG_EVENTS.REFERRAL_REWARDED, { referralId: ref.id, jobId, refereeId: refereeUserId });
  return true;
}
