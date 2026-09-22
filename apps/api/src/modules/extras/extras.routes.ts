import type { FastifyInstance } from 'fastify';
import { forbidden, notFound, businessRule, conflict } from '../../core/errors.js';
import { clientQuery, queryMany, queryOne, transaction } from '../../db/pool.js';
import { LOG_EVENTS, logEvent } from '../../core/logger.js';

/**
 * /boosts, /complaints, /tracking — the spec's "extras" backlog.
 *
 * Each is a separate, independently switchable module: the operator turns it on
 * or off from the admin feature switches, and every route refuses to work for a
 * disabled feature rather than half-serving it.
 *
 * Boost debits the provider's wallet through the ledger (never by writing a
 * balance), complaints open inside the 7-day guarantee window, and a tracking
 * link is a random token that expires with the job.
 */

async function flagEnabled(key: string): Promise<boolean> {
  const row = await queryOne<{ enabled: boolean }>(
    'select enabled from feature_flags where key = $1',
    [key],
  );
  return Boolean(row?.enabled);
}

async function settingNumber(key: string, fallback: number): Promise<number> {
  const row = await queryOne<{ value: unknown }>('select value from settings where key = $1', [key]);
  if (row?.value == null) return fallback;
  const raw = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
  const n = Number(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/** Boost prices are a JSON map of hours -> minor units. */
async function boostPrice(hours: number): Promise<number> {
  const row = await queryOne<{ value: unknown }>(`select value from settings where key = 'providers.boost_prices'`);
  const raw = row?.value ?? { '24': 4900, '72': 12900 };
  const obj = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, number>);
  return Number(obj?.[String(hours)] ?? obj?.[hours] ?? 4900);
}

export async function registerExtrasRoutes(app: FastifyInstance): Promise<void> {
  // ======================= BOOST ==========================================
  app.get('/boosts/prices', {
    schema: { tags: ['boosts'], summary: 'Boost durations and prices' },
  }, async (_request, reply) => {
    const enabled = await flagEnabled('provider_boost');
    const hours = [24, 72];
    const prices = await Promise.all(hours.map((h) => boostPrice(h)));
    return reply.send({
      success: true,
      data: { enabled, options: hours.map((h, i) => ({ hours: h, priceMinor: prices[i] })) },
    });
  });

  app.post('/boosts', {
    preHandler: [app.requireProvider],
    schema: {
      tags: ['boosts'], summary: 'Buy a visibility boost from the wallet', security: [{ bearerAuth: [] }],
      body: {
        type: 'object', required: ['hours'], additionalProperties: false,
        properties: { hours: { type: 'integer', enum: [24, 72] }, cityId: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { hours, cityId } = request.body as { hours: number; cityId?: string };
    if (!(await flagEnabled('provider_boost'))) throw businessRule('Boosts are not available right now.');

    const price = await boostPrice(hours);
    // A zero (or negative) boost price is a misconfiguration, and the ledger
    // rejects a zero movement (`wallet_transactions_amount_minor_check`), so
    // fail with a clear message instead of a 23514 from the insert below.
    if (!(price > 0)) throw businessRule('Boosts are not available right now.');

    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const provider = await c.one<{ id: string }>('select id from providers where user_id = $1', [auth.userId]);
      if (!provider) throw notFound('Provider profile');

      const wallet = await c.one<{ id: string; available_minor: string; currency: string; is_frozen: boolean }>(
        `select id, available_minor, currency, is_frozen from wallets
          where owner_type = 'PROVIDER' and owner_id = $1
          order by created_at limit 1 for update`,
        [auth.userId],
      );
      if (!wallet) throw businessRule('You have no wallet yet.');
      if (wallet.is_frozen) throw businessRule('Your wallet is frozen. Contact support.');

      const balance = Number(wallet.available_minor);
      if (balance < price) throw businessRule('Your wallet balance is not enough for this boost.');

      // Ledger first: the triggers validate and apply the movement.
      const txn = await c.one<{ id: string }>(
        `insert into wallet_transactions
           (wallet_id, direction, type, amount_minor, currency, balance_after_minor,
            reference_type, reference_id, description)
         values ($1, 'DEBIT', 'PROMOTION', $2, $3, $4, 'BOOST', $5, $6)
         returning id`,
        [wallet.id, price, wallet.currency, balance - price, provider.id, `Boost ${hours}h`],
      );

      const boost = await c.one<{ id: string; starts_at: string; ends_at: string }>(
        `insert into provider_boosts
           (provider_id, city_id, duration_hours, price_minor, currency, starts_at, ends_at, is_active, wallet_txn_id)
         values ($1, $2, $3, $4, $5, now(), now() + ($3 || ' hours')::interval, true, $6)
         returning id, starts_at, ends_at`,
        [provider.id, cityId ?? null, hours, price, wallet.currency, txn?.id ?? null],
      );

      // Denormalised mirror the discovery query sorts on.
      await c.query(`update providers set boosted_until = greatest(coalesce(boosted_until, now()), now() + ($2 || ' hours')::interval) where id = $1`,
        [provider.id, hours]);

      return { boost, priceMinor: price, hours };
    });

    logEvent(LOG_EVENTS.BOOST_PURCHASED, { userId: auth.userId, hours, priceMinor: price });
    return reply.status(201).send({ success: true, data: result });
  });

  app.get('/boosts/mine', {
    preHandler: [app.requireProvider],
    schema: { tags: ['boosts'], summary: 'My boost history', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const auth = request.auth!;
    const rows = await queryMany(
      `select b.id, b.duration_hours, b.price_minor, b.currency, b.starts_at, b.ends_at, b.is_active
         from provider_boosts b join providers p on p.id = b.provider_id
        where p.user_id = $1 order by b.created_at desc limit 30`,
      [auth.userId],
    );
    return reply.send({ success: true, data: rows });
  });

  // ======================= COMPLAINTS (7-day guarantee) ====================
  app.post('/complaints', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['complaints'], summary: 'Open a complaint inside the guarantee window', security: [{ bearerAuth: [] }],
      body: {
        type: 'object', required: ['jobId', 'subject', 'body'], additionalProperties: false,
        properties: {
          jobId: { type: 'string', format: 'uuid' },
          subject: { type: 'string', minLength: 3, maxLength: 200 },
          body: { type: 'string', minLength: 10, maxLength: 4000 },
          category: { type: 'string', maxLength: 60 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const b = request.body as { jobId: string; subject: string; body: string; category?: string };
    if (!(await flagEnabled('service_guarantee'))) throw businessRule('The service guarantee is not available right now.');

    const guaranteeDays = await settingNumber('guarantee.window_days', 7);

    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const job = await c.one<{
        id: string; request_id: string; customer_id: string; provider_id: string | null;
        provider_user_id: string | null; status: string; completed_at: string | null;
      }>(
        `select j.id, j.request_id, j.customer_id, j.provider_id, p.user_id as provider_user_id,
                j.status, j.completed_at
           from jobs j left join providers p on p.id = j.provider_id
          where j.id = $1 for update of j`,
        [b.jobId],
      );
      if (!job) throw notFound('Job');
      if (job.customer_id !== auth.userId && job.provider_user_id !== auth.userId && auth.role !== 'ADMIN') {
        throw forbidden();
      }
      if (!['COMPLETED', 'PAID', 'DELIVERED'].includes(job.status)) {
        throw businessRule('You can only complain about a completed job.');
      }
      if (!job.completed_at) throw businessRule('This job has no completion date.');

      // The window is measured from completion, and enforced server-side.
      const row = await c.one<{ within: boolean }>(
        `select ($1::timestamptz + ($2 || ' days')::interval) > now() as within`,
        [job.completed_at, guaranteeDays],
      );
      if (!row?.within) throw businessRule(`The ${guaranteeDays}-day complaint window has closed.`);

      const open = await c.one<{ id: string }>(
        `select id from complaints where job_id = $1 and status in ('OPEN','IN_REVIEW','AWAITING_CUSTOMER')`,
        [b.jobId],
      );
      if (open) throw conflict('There is already an open complaint for this job.');

      const complaint = await c.one<{ id: string; code: string }>(
        `insert into complaints (job_id, request_id, raised_by, against_id, provider_id,
                                 category, subject, body, status, priority, guarantee_days)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN', 'NORMAL', $9)
         returning id, code`,
        [
          b.jobId, job.request_id, auth.userId,
          job.customer_id === auth.userId ? job.provider_user_id : job.customer_id,
          job.provider_id, b.category ?? 'QUALITY', b.subject, b.body, guaranteeDays,
        ],
      );
      return { ...complaint, guaranteeDays };
    });

    logEvent(LOG_EVENTS.COMPLAINT_OPENED, { userId: auth.userId, jobId: b.jobId });
    return reply.status(201).send({ success: true, data: result });
  });

  app.get('/complaints/mine', {
    preHandler: [app.authenticate],
    schema: { tags: ['complaints'], summary: 'My complaints', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const auth = request.auth!;
    const rows = await queryMany(
      `select c.id, c.code, c.subject, c.status::text, c.priority::text, c.guarantee_days,
              c.resolution, c.refund_minor, c.created_at, c.resolved_at, j.code as job_code
         from complaints c
         left join jobs j on j.id = c.job_id
         left join providers p on p.id = c.provider_id
        where c.raised_by = $1 or c.against_id = $1 or p.user_id = $1
        order by c.created_at desc limit 50`,
      [auth.userId],
    );
    return reply.send({ success: true, data: rows });
  });

  /** What the caller may still complain about — drives the UI button. */
  app.get('/complaints/eligibility/:jobId', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['complaints'], summary: 'Whether a job can be complained about', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const auth = request.auth!;
    const enabled = await flagEnabled('service_guarantee');
    const guaranteeDays = await settingNumber('guarantee.window_days', 7);

    const job = await queryOne<{ completed_at: string | null; status: string; customer_id: string }>(
      'select completed_at, status, customer_id from jobs where id = $1',
      [jobId],
    );
    if (!job) throw notFound('Job');

    const within = job.completed_at
      ? await queryOne<{ ok: boolean }>(
          `select ($1::timestamptz + ($2 || ' days')::interval) > now() as ok`,
          [job.completed_at, guaranteeDays],
        )
      : null;
    const open = await queryOne<{ id: string }>(
      `select id from complaints where job_id = $1 and status in ('OPEN','IN_REVIEW','AWAITING_CUSTOMER')`,
      [jobId],
    );

    const finished = ['COMPLETED', 'PAID', 'DELIVERED'].includes(job.status);
    return reply.send({
      success: true,
      data: {
        enabled,
        guaranteeDays,
        canComplain: enabled && finished && Boolean(within?.ok) && !open,
        hasOpenComplaint: Boolean(open),
        windowEndsAt: job.completed_at
          ? new Date(new Date(job.completed_at).getTime() + guaranteeDays * 86400000).toISOString()
          : null,
      },
    });
  });

  // ======================= TRACKING LINKS ==================================
  app.post('/jobs/:id/tracking-link', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['tracking'], summary: 'Create a temporary public tracking link', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: { label: { type: 'string', maxLength: 80 }, hours: { type: 'integer', minimum: 1, maximum: 48 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const { label, hours } = (request.body ?? {}) as { label?: string; hours?: number };
    if (!(await flagEnabled('location_sharing'))) throw businessRule('Location sharing is not available right now.');

    const job = await queryOne<{ customer_id: string; status: string }>(
      'select customer_id, status from jobs where id = $1',
      [id],
    );
    if (!job) throw notFound('Job');
    // Only the customer shares their own location, and only while it matters.
    if (job.customer_id !== auth.userId && auth.role !== 'ADMIN') throw forbidden();
    if (!['CONFIRMED', 'PROVIDER_EN_ROUTE', 'PROVIDER_ARRIVED', 'IN_PROGRESS'].includes(job.status)) {
      throw businessRule('This job is not active, so there is nothing to share.');
    }

    const ttl = Math.min(Math.max(hours ?? 12, 1), 48);
    const link = await queryOne<{ id: string; token: string; expires_at: string }>(
      `insert into tracking_links (job_id, created_by, label, expires_at)
       values ($1, $2, $3, now() + ($4 || ' hours')::interval)
       returning id, token, expires_at`,
      [id, auth.userId, label ?? null, ttl],
    );
    logEvent(LOG_EVENTS.TRACKING_LINK_CREATED, { userId: auth.userId, jobId: id });
    return reply.status(201).send({ success: true, data: { ...link, hours: ttl } });
  });

  app.get('/jobs/:id/tracking-links', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['tracking'], summary: 'Tracking links for a job', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = request.auth!;
    const job = await queryOne<{ customer_id: string }>('select customer_id from jobs where id = $1', [id]);
    if (!job) throw notFound('Job');
    if (job.customer_id !== auth.userId && auth.role !== 'ADMIN') throw forbidden();

    const rows = await queryMany(
      `select id, token, label, expires_at, revoked_at, view_count, last_viewed_at, created_at
         from tracking_links where job_id = $1 order by created_at desc limit 20`,
      [id],
    );
    return reply.send({ success: true, data: rows });
  });

  app.post('/tracking-links/:id/revoke', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['tracking'], summary: 'Revoke a tracking link', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = request.auth!;
    const link = await queryOne<{ id: string; created_by: string }>(
      'select id, created_by from tracking_links where id = $1',
      [id],
    );
    if (!link) throw notFound('Tracking link');
    if (link.created_by !== auth.userId && auth.role !== 'ADMIN') throw forbidden();

    await queryOne(`update tracking_links set revoked_at = now() where id = $1`, [id]);
    return reply.send({ success: true, data: { id } });
  });

  // Public: no auth — the token *is* the credential. Nothing but position.
  app.get('/track/:token', {
    schema: {
      tags: ['tracking'], summary: 'Public tracking payload for a share link',
      params: { type: 'object', required: ['token'], properties: { token: { type: 'string', maxLength: 64 } } },
    },
  }, async (request, reply) => {
    const { token } = request.params as { token: string };
    const link = await queryOne<{
      id: string; job_id: string; expires_at: string; revoked_at: string | null;
      job_status: string; job_code: string; provider_id: string | null;
      provider_name: string | null; pickup_lat: number | null; pickup_lng: number | null;
    }>(
      `select l.id, l.job_id, l.expires_at, l.revoked_at,
              j.status::text as job_status, j.code as job_code, j.provider_id,
              p.display_name as provider_name,
              j.pickup_lat, j.pickup_lng
         from tracking_links l
         join jobs j on j.id = l.job_id
         left join providers p on p.id = j.provider_id
        where l.token = $1`,
      [token],
    );
    if (!link) throw notFound('Tracking link');
    if (link.revoked_at) throw forbidden();
    if (new Date(link.expires_at).getTime() < Date.now()) {
      throw businessRule('This tracking link has expired.');
    }

    await queryOne(
      `update tracking_links set view_count = view_count + 1, last_viewed_at = now() where id = $1`,
      [link.id],
    );

    // Deliberately narrow: no prices, no names of the customer, no contact data.
    return reply.send({
      success: true,
      data: {
        jobCode: link.job_code,
        status: link.job_status,
        providerName: link.provider_name,
        destination: link.pickup_lat != null && link.pickup_lng != null
          ? { lat: Number(link.pickup_lat), lng: Number(link.pickup_lng) }
          : null,
        expiresAt: link.expires_at,
      },
    });
  });

  // ======================= PROVIDER PEAK STATS ============================
  app.get('/providers/me/peak-stats', {
    preHandler: [app.requireProvider],
    schema: { tags: ['providers'], summary: 'Peak demand hours for my area', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const auth = request.auth!;
    const enabled = await flagEnabled('provider_peak_stats');
    if (!enabled) return reply.send({ success: true, data: { enabled: false, byHour: [], byWeekday: [] } });

    const provider = await queryOne<{ id: string }>('select id from providers where user_id = $1', [auth.userId]);
    if (!provider) throw notFound('Provider profile');

    // Live aggregation over the requests this provider could actually serve, so
    // it works before any historical `price_stats` rows have been built.
    const byHour = await queryMany<{ hour: number; requests: number }>(
      `select extract(hour from r.created_at)::int as hour, count(*)::int as requests
         from requests r
         join providers p on p.id = $1
        where r.created_at > now() - interval '90 days'
          and (r.pickup_city_id is null or p.city_id is null or r.pickup_city_id = p.city_id)
        group by 1 order by 1`,
      [provider.id],
    );
    const byWeekday = await queryMany<{ weekday: number; requests: number }>(
      `select extract(dow from r.created_at)::int as weekday, count(*)::int as requests
         from requests r join providers p on p.id = $1
        where r.created_at > now() - interval '90 days'
        group by 1 order by 1`,
      [provider.id],
    );

    return reply.send({ success: true, data: { enabled: true, byHour, byWeekday } });
  });
}
