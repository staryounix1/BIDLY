import type { FastifyInstance } from 'fastify';
import { notFound, forbidden, businessRule } from '../../core/errors.js';
import { clientQuery, queryMany, queryOne, transaction } from '../../db/pool.js';
import { buildPage, parsePagination } from '../../core/pagination.js';
import { generateOtp, hashToken, timingSafeEqualString } from '../../core/tokens.js';
import { assertJobTransition, type JobStatus } from '@bidly/state-machines';
import { LOG_EVENTS, logEvent } from '../../core/logger.js';
import { enqueue, OUTBOX_TOPICS } from '../../core/outbox.js';
import { releaseReferralReward } from '../referrals/referrals.routes.js';

/**
 * /jobs — execution lifecycle.
 *
 * The state machine is enforced here and in the database. The provider starts
 * work by entering an OTP that only the customer holds; this is what makes
 * "provider arrived" and "work started" trustworthy rather than self-reported.
 */
export async function registerJobRoutes(app: FastifyInstance): Promise<void> {
  const ORDER = { createdAt: 'j.created_at', scheduledAt: 'j.scheduled_at', price: 'j.final_price_minor' };

  /**
   * Server-only columns that must never reach a client.
   *
   * `jobs` physically stores the start-of-work code hash (and its expiry) so the
   * provider can be challenged with the customer's one-time code. A `select j.*`
   * row is therefore not safe to serialize as-is: the provider is exactly the
   * party the code protects against. Strip these at every response boundary.
   */
  function sanitizeJob<T extends Record<string, unknown>>(row: T): Omit<T, 'start_otp_hash' | 'start_otp_expires_at'>;
  function sanitizeJob<T extends Record<string, unknown>>(row: T | null): Omit<T, 'start_otp_hash' | 'start_otp_expires_at'> | null;
  function sanitizeJob(row: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!row) return null;
    const { start_otp_hash: _omitHash, start_otp_expires_at: _omitExpiry, ...safe } = row;
    return safe;
  }

  async function loadJobForActor(jobId: string, userId: string, role: string, client?: import('pg').PoolClient) {
    const runner = client ? clientQuery(client) : null;
    const sql = `select j.*, p.user_id as provider_user_id, s.name_en as service_name
                 from jobs j
                 join providers p on p.id = j.provider_id
                 join services s on s.id = j.service_id
                 where j.id = $1`;
    const job = runner ? await runner.one(sql, [jobId]) : await queryOne(sql, [jobId]);
    if (!job) throw notFound('Job');
    const row = job as Record<string, unknown>;
    const isCustomer = row.customer_id === userId;
    const isProvider = row.provider_user_id === userId;
    if (!isCustomer && !isProvider && role !== 'ADMIN') throw forbidden();
    // NOTE: the row is returned un-sanitized because callers (e.g. the start
    // endpoint) need `start_otp_hash` / `start_otp_expires_at` internally.
    // Every response boundary must pass the value through `sanitizeJob`.
    return { job: row, isCustomer, isProvider };
  }

  // -------- mine -------------------------------------------------------
  app.get('/jobs/mine', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['jobs'], summary: 'List my jobs (as customer or provider)', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          status: { type: 'string' }, role: { type: 'string', enum: ['customer', 'provider'] },
          sortBy: { type: 'string' }, sortDir: { type: 'string', enum: ['asc', 'desc'] },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);

    const where: string[] = ['j.deleted_at is null'];
    const params: unknown[] = [];

    if (q.role === 'provider') {
      params.push(auth.userId);
      where.push(`p.user_id = $${params.length}`);
    } else if (q.role === 'customer') {
      params.push(auth.userId);
      where.push(`j.customer_id = $${params.length}`);
    } else {
      params.push(auth.userId);
      where.push(`(j.customer_id = $${params.length} or p.user_id = $${params.length})`);
    }
    if (q.status) { params.push(q.status); where.push(`j.status = $${params.length}`); }

    const orderBy =
      q.sortBy === 'price' ? `j.final_price_minor ${q.sortDir === 'asc' ? 'asc' : 'desc'}`
      : q.sortBy === 'scheduledAt' ? `j.scheduled_at ${q.sortDir === 'asc' ? 'asc' : 'desc'} nulls last`
      : 'j.created_at desc';

    const rows = await queryMany(
      `select j.*, p.display_name as provider_name, s.name_en as service_name,
              cu.email as customer_email
       from jobs j
       join providers p on p.id = j.provider_id
       join services s on s.id = j.service_id
       join users cu on cu.id = j.customer_id
       where ${where.join(' and ')} order by ${orderBy}
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    const total = await queryOne<{ count: string }>(
      `select count(*)::text as count from jobs j join providers p on p.id = j.provider_id where ${where.join(' and ')}`,
      params,
    );
    return reply.send({ success: true, data: buildPage(rows.map(sanitizeJob), Number(total?.count ?? 0), page) });
  });

  // -------- one ------------------------------------------------------- 
  app.get('/jobs/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['jobs'], summary: 'Get a job with its event timeline', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const { job } = await loadJobForActor(id, auth.userId, auth.role);
    const events = await queryMany(
      `select id, type, from_status, to_status, actor_role, note, created_at
       from job_events where job_id = $1 order by created_at`,
      [id],
    );
    const payment = await queryOne(
      `select id, status, amount_minor, currency, commission_minor, provider_net_minor, method, captured_at
       from payments where job_id = $1`,
      [id],
    );
    return reply.send({ success: true, data: { job: sanitizeJob(job), events, payment } });
  });

  // -------- provider: en route ----------------------------------------
  app.post('/jobs/:id/en-route', {
    preHandler: [app.requireProvider],
    schema: {
      tags: ['jobs'], summary: 'Mark the provider as en route', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: { lat: { type: 'number' }, lng: { type: 'number' } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = (request.body ?? {}) as { lat?: number; lng?: number };

    const result = await transaction(async (client) => {
      const { job, isProvider } = await loadJobForActor(id, auth.userId, auth.role, client);
      if (!isProvider && auth.role !== 'ADMIN') throw forbidden();
      assertJobTransition(job.status as JobStatus, 'PROVIDER_EN_ROUTE');

      const updated = await clientQuery(client).one(
        `update jobs set status = 'PROVIDER_EN_ROUTE', provider_en_route_at = now() where id = $1 returning *`,
        [id],
      );
      await clientQuery(client).query(
        `insert into job_events (job_id, request_id, type, from_status, to_status, actor_id, actor_role, lat, lng)
         values ($1,$2,'PROVIDER_EN_ROUTE',$3,'PROVIDER_EN_ROUTE',$4,'PROVIDER',$5,$6)`,
        [id, job.request_id, job.status, auth.userId, b.lat ?? null, b.lng ?? null],
      );
      return updated;
    });
    return reply.send({ success: true, data: sanitizeJob(result) });
  });

  // -------- provider: arrived -----------------------------------------
  app.post('/jobs/:id/arrived', {
    preHandler: [app.requireProvider],
    schema: {
      tags: ['jobs'], summary: 'Mark the provider as arrived', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };

    const result = await transaction(async (client) => {
      const { job, isProvider } = await loadJobForActor(id, auth.userId, auth.role, client);
      if (!isProvider && auth.role !== 'ADMIN') throw forbidden();
      assertJobTransition(job.status as JobStatus, 'PROVIDER_ARRIVED');
      return clientQuery(client).one(`update jobs set status = 'PROVIDER_ARRIVED', arrived_at = now() where id = $1 returning *`, [id]);
    });
    return reply.send({ success: true, data: sanitizeJob(result) });
  });

  // -------- customer: start OTP ---------------------------------------
  app.post('/jobs/:id/start-otp', {
    preHandler: [app.requireCustomer],
    schema: {
      tags: ['jobs'], summary: 'Get the start-of-work OTP (customer only)', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };

    const result = await transaction(async (client) => {
      const { job, isCustomer } = await loadJobForActor(id, auth.userId, auth.role, client);
      if (!isCustomer && auth.role !== 'ADMIN') throw forbidden();
      if (!['CONFIRMED', 'PROVIDER_EN_ROUTE', 'PROVIDER_ARRIVED'].includes(job.status as string)) {
        throw businessRule('A start code can only be issued before work begins.');
      }
      const otp = generateOtp(6);
      await clientQuery(client).query(
        `update jobs set start_otp_hash = $2, start_otp_expires_at = now() + interval '2 hours' where id = $1`,
        [id, hashToken(otp)],
      );
      return { otp, expiresInSeconds: 2 * 60 * 60 };
    });

    return reply.send({
      success: true,
      data: { ...result, note: 'Share this code with the provider when they arrive to confirm the start of work.' },
    });
  });

  // -------- provider: start with OTP ----------------------------------
  app.post('/jobs/:id/start', {
    preHandler: [app.requireProvider],
    schema: {
      tags: ['jobs'], summary: 'Start work using the customer start code', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', required: ['otp'],
        additionalProperties: false,
        properties: { otp: { type: 'string', minLength: 4, maxLength: 8 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = request.body as { otp: string };

    const result = await transaction(async (client) => {
      const { job, isProvider } = await loadJobForActor(id, auth.userId, auth.role, client);
      if (!isProvider && auth.role !== 'ADMIN') throw forbidden();
      assertJobTransition(job.status as JobStatus, 'IN_PROGRESS');

      const hash = job.start_otp_hash as string | null;
      const expiry = job.start_otp_expires_at as Date | null;
      if (!hash) throw businessRule('No start code has been issued for this job.');
      if (expiry && expiry.getTime() <= Date.now()) throw businessRule('The start code has expired. Ask the customer for a new one.');
      if (!timingSafeEqualString(hash, hashToken(b.otp))) throw businessRule('The start code is incorrect.');

      const updated = await clientQuery(client).one(
        `update jobs set status = 'IN_PROGRESS', started_at = now(), start_otp_hash = null where id = $1 returning *`,
        [id],
      );
      await clientQuery(client).query(
        `insert into job_events (job_id, request_id, type, from_status, to_status, actor_id, actor_role)
         values ($1,$2,'STATUS_CHANGE',$3,'IN_PROGRESS',$4,'PROVIDER')`,
        [id, job.request_id, job.status, auth.userId],
      );
      await clientQuery(client).query(`update requests set status = 'IN_PROGRESS' where id = $1`, [job.request_id]);
      await enqueue(
        {
          topic: OUTBOX_TOPICS.JOB_STATUS_CHANGED,
          aggregateType: 'JOB',
          aggregateId: id,
          payload: {
            jobId: id,
            requestId: job.request_id,
            status: 'IN_PROGRESS',
            title: String(job.code ?? ''),
            recipients: [
              { userId: job.customer_id as string, role: 'CUSTOMER' },
              { userId: job.provider_user_id as string, role: 'PROVIDER' },
            ],
          },
        },
        client,
      );
      logEvent(LOG_EVENTS.JOB_STARTED, { jobId: id, providerId: job.provider_id });
      return updated;
    });
    return reply.send({ success: true, data: sanitizeJob(result) });
  });

  // -------- provider: complete ----------------------------------------
  app.post('/jobs/:id/complete', {
    preHandler: [app.requireProvider],
    schema: {
      tags: ['jobs'], summary: 'Mark work as complete', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          note: { type: 'string', maxLength: 1000 },
          photoUrls: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 2048 } },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = (request.body ?? {}) as { note?: string; photoUrls?: string[] };

    const result = await transaction(async (client) => {
      const { job, isProvider } = await loadJobForActor(id, auth.userId, auth.role, client);
      if (!isProvider && auth.role !== 'ADMIN') throw forbidden();
      assertJobTransition(job.status as JobStatus, 'COMPLETED');

      const updated = await clientQuery(client).one(
        `update jobs set status = 'COMPLETED', completed_at = now(),
               completion_note = $2, completion_photos = coalesce($3::jsonb, '[]'::jsonb),
               auto_confirm_at = now() + interval '72 hours'
         where id = $1 returning *`,
        [id, b.note ?? null, b.photoUrls ? JSON.stringify(b.photoUrls) : null],
      );
      await clientQuery(client).query(
        `insert into job_events (job_id, request_id, type, from_status, to_status, actor_id, actor_role)
         values ($1,$2,'STATUS_CHANGE',$3,'COMPLETED',$4,'PROVIDER')`,
        [id, job.request_id, job.status, auth.userId],
      );
      await clientQuery(client).query(`update requests set status = 'COMPLETED', completed_at = now() where id = $1`, [job.request_id]);

      // A completed job is what qualifies an invite code: pay both sides once.
      // Never fatal to the completion — a referral problem must not undo work.
      await releaseReferralReward(clientQuery(client), String(job.customer_id), id).catch(() => undefined);
      await enqueue(
        {
          topic: OUTBOX_TOPICS.JOB_STATUS_CHANGED,
          aggregateType: 'JOB',
          aggregateId: id,
          payload: {
            jobId: id,
            requestId: job.request_id,
            status: 'COMPLETED',
            title: String(job.code ?? ''),
            recipients: [
              { userId: job.customer_id as string, role: 'CUSTOMER' },
              { userId: job.provider_user_id as string, role: 'PROVIDER' },
            ],
          },
        },
        client,
      );
      logEvent(LOG_EVENTS.JOB_COMPLETED, { jobId: id, providerId: job.provider_id });
      return updated;
    });
    return reply.send({ success: true, data: sanitizeJob(result) });
  });

  // -------- customer: confirm ------------------------------------------
  app.post('/jobs/:id/confirm', {
    preHandler: [app.requireCustomer],
    schema: {
      tags: ['jobs'], summary: 'Confirm completion (moves the job to payment)', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };

    const result = await transaction(async (client) => {
      const { job, isCustomer } = await loadJobForActor(id, auth.userId, auth.role, client);
      if (!isCustomer && auth.role !== 'ADMIN') throw forbidden();
      if (job.status !== 'COMPLETED') throw businessRule('Only a completed job can be confirmed.');

      const updated = await clientQuery(client).one(
        `update jobs set confirmed_at = now(), status = 'PAYMENT_PENDING' where id = $1 returning *`,
        [id],
      );
      await clientQuery(client).query(
        `insert into job_events (job_id, request_id, type, from_status, to_status, actor_id, actor_role)
         values ($1,$2,'CUSTOMER_CONFIRMED','COMPLETED','PAYMENT_PENDING',$3,'CUSTOMER')`,
        [id, job.request_id, auth.userId],
      );
      return updated;
    });
    return reply.send({ success: true, data: sanitizeJob(result) });
  });

  // -------- cancel ------------------------------------------------------
  app.post('/jobs/:id/cancel', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['jobs'], summary: 'Cancel a job (cancellation fee follows the configured policy)', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: { reason: { type: 'string', maxLength: 500 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = (request.body ?? {}) as { reason?: string };

    const result = await transaction(async (client) => {
      const { job, isCustomer, isProvider } = await loadJobForActor(id, auth.userId, auth.role, client);
      if (!isCustomer && !isProvider && auth.role !== 'ADMIN') throw forbidden();
      assertJobTransition(job.status as JobStatus, 'CANCELLED');

      const side = isCustomer ? 'CUSTOMER' : 'PROVIDER';
      const price = Number(job.final_price_minor);
      const stage = ['CREATED', 'CONFIRMED'].includes(job.status as string)
        ? 'PROVIDER_SELECTED'
        : ['PROVIDER_EN_ROUTE', 'PROVIDER_ARRIVED'].includes(job.status as string)
          ? 'PROVIDER_EN_ROUTE'
          : 'IN_PROGRESS';

      const policy = await clientQuery(client).one<{
        fee_model: string; fee_percent_bps: number | null; fee_fixed_minor: string | null; cap_minor: string | null;
      }>(
        `select fee_model, fee_percent_bps, fee_fixed_minor, cap_minor
         from cancellation_policies
         where is_active and stage = $1 and cancelled_by = $2 and scope = 'GLOBAL'
         order by created_at desc limit 1`,
        [stage, side],
      );

      let feeMinor = 0;
      if (policy) {
        if (policy.fee_model === 'PERCENT') feeMinor = Math.round((price * (policy.fee_percent_bps ?? 0)) / 10000);
        else if (policy.fee_model === 'FIXED') feeMinor = Number(policy.fee_fixed_minor ?? 0);
        if (policy.cap_minor) feeMinor = Math.min(feeMinor, Number(policy.cap_minor));
      }
      feeMinor = Math.min(Math.max(feeMinor, 0), price);

      const updated = await clientQuery(client).one(
        `update jobs set status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2,
               cancelled_by_role = $3, cancellation_reason = $4, cancellation_fee_minor = $5
         where id = $1 returning *`,
        [id, auth.userId, side, b.reason ?? null, feeMinor],
      );
      await clientQuery(client).query(
        `insert into job_events (job_id, request_id, type, from_status, to_status, actor_id, actor_role, payload, note)
         values ($1,$2,'CANCELLED',$3,'CANCELLED',$4,$5,$6::jsonb,$7)`,
        [
          id, job.request_id, job.status, auth.userId, side,
          JSON.stringify({ stage, feeMinor }), b.reason ?? null,
        ],
      );
      await clientQuery(client).query(`update requests set status = 'CANCELLED', cancelled_at = now() where id = $1`, [job.request_id]);
      await clientQuery(client).query(
        `update offers set status = 'WITHDRAWN' where request_id = $1 and status in ('PENDING','ACCEPTED')`,
        [job.request_id],
      );

      await enqueue(
        {
          topic: OUTBOX_TOPICS.JOB_STATUS_CHANGED,
          aggregateType: 'JOB',
          aggregateId: id,
          payload: {
            jobId: id,
            requestId: job.request_id,
            status: 'CANCELLED',
            title: String(job.code ?? ''),
            cancelledByRole: side,
            reason: b.reason ?? null,
            recipients: [
              { userId: job.customer_id as string, role: 'CUSTOMER' },
              { userId: job.provider_user_id as string, role: 'PROVIDER' },
            ],
          },
        },
        client,
      );

      logEvent(LOG_EVENTS.JOB_CANCELLED, { jobId: id, by: side, feeMinor, stage });
      return { ...(updated as object), cancellationFeeMinor: feeMinor, stage };
    });

    return reply.send({ success: true, data: sanitizeJob(result) });
  });
}
