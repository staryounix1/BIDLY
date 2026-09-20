import type { FastifyInstance } from 'fastify';
import { notFound, businessRule, forbidden } from '../../core/errors.js';
import { clientQuery, queryMany, queryOne, transaction } from '../../db/pool.js';
import { parsePagination, pageMeta } from '../../core/pagination.js';
import { logEvent, LOG_EVENTS } from '../../core/logger.js';
import { resolveCommission } from '../payments/payment-provider.js';
import { ADMIN_PERMISSIONS } from '../../core/rbac.js';
import type { CommissionRule, StoredCommissionRule } from '@bidly/money';

/**
 * /admin — operations console.
 *
 * Every mutating admin endpoint writes an `admin_actions` row (append-only) in
 * the same transaction as the change it makes. Admin authority is derived from
 * `admins` + role, re-checked per request; nothing is trusted from the client.
 */
export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // Each endpoint is gated by the least privilege it needs, so an ADMIN with a
  // narrow permission set (e.g. FINANCE) cannot reach unrelated endpoints.
  const can = (permission: (typeof ADMIN_PERMISSIONS)[keyof typeof ADMIN_PERMISSIONS]) => [app.requirePermission(permission)];
  const usersRead = can(ADMIN_PERMISSIONS.USERS_READ);
  const usersWrite = can(ADMIN_PERMISSIONS.USERS_WRITE);
  const usersSuspend = can(ADMIN_PERMISSIONS.USERS_SUSPEND);
  const providersRead = can(ADMIN_PERMISSIONS.PROVIDERS_READ);
  const providersVerify = can(ADMIN_PERMISSIONS.PROVIDERS_VERIFY);
  const requestsRead = can(ADMIN_PERMISSIONS.REQUESTS_READ);
  const jobsRead = can(ADMIN_PERMISSIONS.JOBS_READ);
  const jobsIntervene = can(ADMIN_PERMISSIONS.JOBS_INTERVENE);
  const disputesRead = can(ADMIN_PERMISSIONS.DISPUTES_READ);
  const disputesResolve = can(ADMIN_PERMISSIONS.DISPUTES_RESOLVE);
  const paymentsRead = can(ADMIN_PERMISSIONS.PAYMENTS_READ);
  const paymentsWrite = can(ADMIN_PERMISSIONS.PAYMENTS_WRITE);
  const payoutsRead = can(ADMIN_PERMISSIONS.PAYOUTS_READ);
  const payoutsApprove = can(ADMIN_PERMISSIONS.PAYOUTS_APPROVE);
  const settingsRead = can(ADMIN_PERMISSIONS.SETTINGS_READ);
  const settingsWrite = can(ADMIN_PERMISSIONS.SETTINGS_WRITE);
  const catalogRead = can(ADMIN_PERMISSIONS.CATALOG_READ);
  const catalogWrite = can(ADMIN_PERMISSIONS.CATALOG_WRITE);
  const auditRead = can(ADMIN_PERMISSIONS.AUDIT_READ);
  const commissionWrite = can(ADMIN_PERMISSIONS.COMMISSION_WRITE);

  /**
   * Coerce an audit snapshot into an object so extra keys can be merged in.
   *
   * Snapshots are usually rows, but a caller may pass a scalar or null; those
   * are wrapped under `value` rather than dropped, so the trail never loses the
   * before/after state.
   */
  function toObject(snapshot: unknown): Record<string, unknown> {
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
      return { ...(snapshot as Record<string, unknown>) };
    }
    return snapshot === undefined || snapshot === null ? {} : { value: snapshot };
  }

  async function recordAction(
    client: import('pg').PoolClient,
    adminUserId: string,
    action: string,
    targetType: string,
    targetId: string | null,
    before: unknown,
    after: unknown,
    reason?: string,
  ) {
    // `admin_actions.admin_id` references `admins(id)`, not `users(id)`, and the
    // target columns are `target_type` / `target_id`. `admins.user_id` links the
    // admin record to the authenticated user, so resolve it here (null is fine:
    // the FK is on delete set null and the email is denormalised for the trail).
    const admin = await client.query<{ id: string; email: string }>(
      `select id, email from admins where user_id = $1 limit 1`,
      [adminUserId],
    );
    const row = admin.rows[0] ?? null;

    // `target_id` is typed uuid, but settings and feature flags are keyed by
    // text (e.g. `platform.name`, `sos_requests`). Passing a text key straight
    // through made Postgres raise 22P02 (invalid input syntax for type uuid),
    // which surfaced as a generic 400 on every settings update. Keep real ids
    // as uuids for referential usefulness and park text keys in the JSON
    // snapshots, where the audit trail can still read them.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = typeof targetId === 'string' && UUID_RE.test(targetId);
    const columnTargetId = isUuid ? targetId : null;
    const beforeState = isUuid ? (before ?? null) : { ...(toObject(before)), targetId };
    const afterState = isUuid ? (after ?? null) : { ...(toObject(after)), targetId };

    await client.query(
      `insert into admin_actions (admin_id, admin_email, action, target_type, target_id, before_state, after_state, reason)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
      [
        row?.id ?? null, row?.email ?? null, action, targetType, columnTargetId,
        JSON.stringify(beforeState), JSON.stringify(afterState), reason ?? null,
      ],
    );
  }

  // -------- dashboard ---------------------------------------------------
  app.get('/admin/stats', { preHandler: [app.requireAdmin], schema: { tags: ['admin'], summary: 'Platform KPIs', security: [{ bearerAuth: [] }] } },
    async (_request, reply) => {
      const stats = await queryOne(
        `select
           (select count(*)::int from users where deleted_at is null and status = 'ACTIVE') as active_users,
           (select count(*)::int from providers where status = 'ACTIVE') as active_providers,
           (select count(*)::int from requests where created_at > now() - interval '7 days') as requests_7d,
           (select count(*)::int from jobs where created_at > now() - interval '7 days') as jobs_7d,
           (select count(*)::int from jobs where status in ('DISPUTED')) as open_disputes,
           (select count(*)::int from payouts where status = 'REQUESTED') as pending_payouts,
           (select count(*)::int from support_tickets where status in ('OPEN','PENDING')) as open_tickets,
           (select coalesce(sum(gross_minor),0)::text from platform_earnings where recorded_at > now() - interval '30 days') as gmv_30d_minor,
           (select coalesce(sum(commission_minor),0)::text from platform_earnings where recorded_at > now() - interval '30 days') as revenue_30d_minor`,
      );
      return reply.send({ success: true, data: stats });
    });

  app.get('/admin/audit-log', {
    preHandler: auditRead,
    schema: {
      tags: ['admin'], summary: 'Append-only admin action log', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      },
    },
  }, async (request, reply) => {
    const page = parsePagination(request.query as Record<string, unknown>);
    const rows = await queryMany(
      `select a.id, a.action, a.target_type, a.target_id, a.reason, a.created_at,
              coalesce(up.display_name, a.admin_email) as admin_name
       from admin_actions a
       left join admins ad on ad.id = a.admin_id
       left join users u on u.id = ad.user_id
       left join user_profiles up on up.user_id = u.id
       order by a.created_at desc limit $1 offset $2`,
      [page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows, meta: pageMeta(page, rows.length) });
  });

  // -------- users -------------------------------------------------------
  app.get('/admin/users', {
    preHandler: usersRead,
    schema: {
      tags: ['admin'], summary: 'List / search users', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          role: { type: 'string', enum: ['CUSTOMER', 'PROVIDER', 'ADMIN'] },
          status: { type: 'string' }, q: { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const page = parsePagination(query);
    const params: unknown[] = [];
    const where: string[] = ['u.deleted_at is null'];
    if (query.role) { params.push(query.role); where.push(`u.role = $${params.length}`); }
    if (query.status) { params.push(query.status); where.push(`u.status = $${params.length}`); }
    if (query.q) {
      params.push(`%${query.q}%`);
      where.push(`(p.display_name ilike $${params.length} or u.email ilike $${params.length} or u.phone ilike $${params.length})`);
    }
    const rows = await queryMany(
      `select u.id, u.email, u.phone, p.display_name, u.role, u.status, u.locale, u.country_code,
              u.created_at, u.last_login_at
       from users u left join user_profiles p on p.user_id = u.id
       where ${where.join(' and ')} order by u.created_at desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows, meta: pageMeta(page, rows.length) });
  });

  app.post('/admin/users/:id/suspend', {
    preHandler: usersSuspend,
    schema: {
      tags: ['admin'], summary: 'Suspend a user account', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason: string };
    if (id === auth.userId) throw businessRule('You cannot suspend your own account.');

    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const before = await c.one<{ status: string; role: string }>('select status, role from users where id = $1 for update', [id]);
      if (!before) throw notFound('User');
      if (before.role === 'ADMIN') throw forbidden();
      await c.query(`update users set status = 'SUSPENDED', updated_at = now() where id = $1`, [id]);
      await c.query(`update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [id]);
      await recordAction(client, auth.userId, 'SUSPEND_USER', 'user', id, before, { status: 'SUSPENDED' }, reason);
      return { id, status: 'SUSPENDED' };
    });
    logEvent(LOG_EVENTS.ADMIN_ACTION, { adminId: auth.userId, action: 'SUSPEND_USER', entityId: id });
    return reply.send({ success: true, data: result });
  });

  app.post('/admin/users/:id/reinstate', {
    preHandler: usersSuspend,
    schema: {
      tags: ['admin'], summary: 'Reinstate a suspended user', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const before = await c.one<{ status: string }>('select status from users where id = $1 for update', [id]);
      if (!before) throw notFound('User');
      await c.query(`update users set status = 'ACTIVE', updated_at = now() where id = $1`, [id]);
      await recordAction(client, auth.userId, 'REINSTATE_USER', 'user', id, before, { status: 'ACTIVE' });
      return { id, status: 'ACTIVE' };
    });
    logEvent(LOG_EVENTS.ADMIN_ACTION, { adminId: auth.userId, action: 'REINSTATE_USER', entityId: id });
    return reply.send({ success: true, data: result });
  });

  // -------- provider verification --------------------------------------
  app.get('/admin/providers/pending', {
    preHandler: providersRead,
    schema: { tags: ['admin'], summary: 'Providers awaiting verification', security: [{ bearerAuth: [] }] },
  }, async (_request, reply) => {
    const rows = await queryMany(
      `select p.id, p.display_name, p.status, p.verification_status, p.created_at,
              up.display_name as owner_name, u.email as owner_email, u.phone as owner_phone
       from providers p join users u on u.id = p.user_id
       left join user_profiles up on up.user_id = u.id
       where p.verification_status in ('PENDING','REJECTED','UNVERIFIED')
       order by p.created_at`,
    );
    return reply.send({ success: true, data: rows });
  });

  app.post('/admin/providers/:id/verify', {
    preHandler: providersVerify,
    schema: {
      tags: ['admin'], summary: 'Approve or reject a provider', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', required: ['decision'], additionalProperties: false,
        properties: {
          decision: { type: 'string', enum: ['APPROVE', 'REJECT'] },
          reason: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = request.body as { decision: 'APPROVE' | 'REJECT'; reason?: string };
    const approved = b.decision === 'APPROVE';

    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const before = await c.one<{ status: string; verification_status: string }>(
        'select status, verification_status from providers where id = $1 for update', [id],
      );
      if (!before) throw notFound('Provider');
      const after = approved
        ? { status: 'ACTIVE', verification_status: 'VERIFIED' }
        : { status: 'SUSPENDED', verification_status: 'REJECTED' };
      await c.query(
        `update providers set status = $2::bidly_provider_status, verification_status = $3::bidly_verification_status,
                verified_at = case when $4 then now() else verified_at end,
                suspension_reason = case when $4 then null else $5 end, updated_at = now()
         where id = $1`,
        [id, after.status, after.verification_status, approved, b.reason ?? null],
      );
      await recordAction(client, auth.userId, approved ? 'APPROVE_PROVIDER' : 'REJECT_PROVIDER', 'provider', id, before, after, b.reason);
      return { id, ...after };
    });
    logEvent(LOG_EVENTS.ADMIN_ACTION, { adminId: auth.userId, action: 'VERIFY_PROVIDER', entityId: id, approved });
    return reply.send({ success: true, data: result });
  });

  // -------- disputes ----------------------------------------------------
  app.get('/admin/disputes', {
    preHandler: disputesRead,
    schema: {
      tags: ['admin'], summary: 'Dispute queue', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          status: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status) { params.push(q.status); where.push(`d.status = $${params.length}`); }
    const rows = await queryMany(
      `select d.id, d.job_id, d.reason_code as category, d.status, d.priority, d.description, d.resolution,
              d.created_at, r.title as job_title, j.final_price_minor as amount_minor, j.currency
       from disputes d
       join jobs j on j.id = d.job_id
       left join requests r on r.id = j.request_id
       ${where.length ? `where ${where.join(' and ')}` : ''}
       order by case d.priority when 'URGENT' then 0 when 'HIGH' then 1 when 'NORMAL' then 2 else 3 end, d.created_at
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows, meta: pageMeta(page, rows.length) });
  });

  app.post('/admin/disputes/:id/resolve', {
    preHandler: disputesResolve,
    schema: {
      tags: ['admin'], summary: 'Resolve a dispute', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', required: ['resolution', 'outcome'], additionalProperties: false,
        properties: {
          outcome: { type: 'string', enum: ['REFUND_FULL', 'REFUND_PARTIAL', 'RELEASE_TO_PROVIDER', 'DISMISSED'] },
          resolution: { type: 'string', minLength: 5, maxLength: 2000 },
          refundAmountMinor: { type: 'integer', minimum: 0 },
          refundPercent: { type: 'integer', minimum: 0, maximum: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = request.body as { outcome: string; resolution: string; refundAmountMinor?: number; refundPercent?: number };

    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const adminRow = await c.one<{ id: string }>('select id from admins where user_id = $1 limit 1', [auth.userId]);
      const adminRowId = adminRow?.id ?? null;
      const dispute = await c.one<{
        id: string; job_id: string; status: string; opened_by: string;
      }>('select id, job_id, status, opened_by from disputes where id = $1 for update', [id]);
      if (!dispute) throw notFound('Dispute');
      if (['RESOLVED', 'CLOSED', 'WITHDRAWN'].includes(dispute.status)) throw businessRule('This dispute is already closed.');

      const payment = await c.one<{
        id: string; amount_minor: string; currency: string; status: string; commission_minor: string; provider_id: string | null;
      }>(
        `select id, amount_minor, currency, status, commission_minor, provider_id
         from payments where job_id = $1 order by created_at desc limit 1`,
        [dispute.job_id],
      );

      let refundMinor = 0;
      let refundRowId: string | null = null;
      if (payment && ['CAPTURED', 'PARTIALLY_REFUNDED'].includes(payment.status)) {
        const captured = Number(payment.amount_minor);
        if (b.outcome === 'REFUND_FULL') refundMinor = captured;
        else if (b.outcome === 'REFUND_PARTIAL') {
          refundMinor = b.refundAmountMinor
            ?? Math.round((captured * (b.refundPercent ?? 50)) / 100);
        }
        if (refundMinor > captured) throw businessRule('The refund amount cannot exceed the captured amount.');

        if (refundMinor > 0) {
          const isPartial = refundMinor < captured;
          const refundRow = await c.one<{ id: string }>(
            `insert into refunds (payment_id, job_id, amount_minor, currency, status, reason, is_partial, requested_by, requested_by_role, approved_by, processed_at)
             values ($1,$2,$3,$4,'COMPLETED',$5,$6,$7,'ADMIN',$8,now())
             returning id`,
            [
              payment.id, dispute.job_id, refundMinor, payment.currency, b.resolution.slice(0, 200),
              isPartial, auth.userId, adminRowId,
            ],
          );
          refundRowId = refundRow?.id ?? null;
          await c.query(
            `insert into payment_transactions (payment_id, job_id, type, provider_name, amount_minor, currency, status, idempotency_key)
             values ($1,$2,'REFUND','internal',$3,$4,'SUCCESS',$5)
             on conflict (idempotency_key) where idempotency_key is not null do nothing`,
            [payment.id, dispute.job_id, refundMinor, payment.currency, `dispute-refund:${dispute.id}`],
          );
          await c.query(
            `update payments set status = $2, refunded_minor = refunded_minor + $3, updated_at = now() where id = $1`,
            [payment.id, isPartial ? 'PARTIALLY_REFUNDED' : 'REFUNDED', refundMinor],
          );

          // Reverse the corresponding portion of the provider's earning.
          if (payment.provider_id) {
            const providerUser = await c.one<{ user_id: string }>('select user_id from providers where id = $1', [payment.provider_id]);
            if (providerUser) {
              const wallet = await c.one<{ id: string; available_minor: string }>(
                `select id, available_minor from wallets where owner_type = 'PROVIDER' and owner_id = $1 for update`,
                [providerUser.user_id],
              );
              if (wallet) {
                const clawback = Math.min(refundMinor, Number(wallet.available_minor));
                if (clawback > 0) {
                  const newBalance = Number(wallet.available_minor) - clawback;
                  await c.query(
                    `insert into wallet_transactions (wallet_id, type, direction, amount_minor, currency, balance_after_minor,
                                                      reference_type, reference_id, job_id, payment_id, description)
                     values ($1,'REFUND_DEBIT','DEBIT',$2,$3,$4,'refund',$5,$6,$7,$8)`,
                    [wallet.id, clawback, payment.currency, newBalance, refundRowId, dispute.job_id, payment.id,
                      `Clawback for dispute ${dispute.id}`],
                  );
                  await c.query(`update wallets set available_minor = $2, updated_at = now() where id = $1`, [wallet.id, newBalance]);
                }
              }
            }
          }
        }
      }

      await c.query(
        `update disputes set status = 'RESOLVED', resolution = $2, resolution_type = $3,
                resolution_amount_minor = $4, refund_id = $5, resolved_at = now(), updated_at = now()
         where id = $1`,
        [id, b.resolution, b.outcome, refundMinor, refundRowId],
      );
      await c.query(
        `insert into audit_logs (actor_id, actor_type, actor_role, action, entity_type, entity_id, after_state)
         values ($1,'ADMIN','ADMIN','DISPUTE_RESOLVED','dispute',$2,$3::jsonb)`,
        [auth.userId, id, JSON.stringify({ outcome: b.outcome, resolution: b.resolution, refundMinor })],
      );
      await c.query(
        `update jobs set status = case when $2 = 'DISMISSED' then 'COMPLETED' else 'REFUNDED' end, updated_at = now()
         where id = $1 and status = 'DISPUTED'`,
        [dispute.job_id, b.outcome],
      );

      await recordAction(client, auth.userId, 'RESOLVE_DISPUTE', 'dispute', id,
        { status: dispute.status },
        { status: 'RESOLVED', outcome: b.outcome, refundMinor },
        b.resolution);

      return { id, status: 'RESOLVED', outcome: b.outcome, refundMinor };
    });
    logEvent(LOG_EVENTS.ADMIN_ACTION, { adminId: auth.userId, action: 'RESOLVE_DISPUTE', entityId: id });
    return reply.send({ success: true, data: result });
  });

  // -------- payouts -----------------------------------------------------
  app.get('/admin/payouts', {
    preHandler: payoutsRead,
    schema: {
      tags: ['admin'], summary: 'Payout queue', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { status: { type: 'string' }, page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      },
    },
  }, async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);
    const params: unknown[] = [];
    let where = '';
    if (q.status) { params.push(q.status); where = `where po.status = $${params.length}`; }
    const rows = await queryMany(
      `select po.id, po.amount_minor, po.currency, po.method, po.destination_masked, po.status,
              po.requested_at, po.processed_at, coalesce(pr.display_name, u.email) as provider_name, u.email as provider_email
       from payouts po join users u on u.id = po.user_id
       left join user_profiles pr on pr.user_id = u.id ${where}
       order by po.requested_at limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows, meta: pageMeta(page, rows.length) });
  });

  app.post('/admin/payouts/:id/process', {
    preHandler: payoutsApprove,
    schema: {
      tags: ['admin'], summary: 'Approve / reject a payout', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', required: ['decision'], additionalProperties: false,
        properties: {
          decision: { type: 'string', enum: ['APPROVE', 'REJECT'] },
          reason: { type: 'string', maxLength: 500 },
          externalRef: { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = request.body as { decision: 'APPROVE' | 'REJECT'; reason?: string; externalRef?: string };

    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const adminRow = await c.one<{ id: string }>('select id from admins where user_id = $1 limit 1', [auth.userId]);
      const adminRowId = adminRow?.id ?? null;
      const payout = await c.one<{
        id: string; user_id: string; wallet_id: string; amount_minor: string; currency: string; status: string;
      }>('select id, user_id, wallet_id, amount_minor, currency, status from payouts where id = $1 for update', [id]);
      if (!payout) throw notFound('Payout');
      if (payout.status !== 'REQUESTED') throw businessRule(`This payout is already ${payout.status}.`);

      if (b.decision === 'APPROVE') {
        await c.query(
          `update payouts set status = 'PAID', provider_ref = $2, approved_by = $3, approved_at = now(),
                  processed_at = now(), paid_at = now(), updated_at = now()
           where id = $1`,
          [id, b.externalRef ?? null, adminRowId],
        );
        // The debit ledger entry was written when the payout was requested;
        // approval only settles the reserved amount out of the wallet.
        const wallet = await c.one<{ reserved_minor: string }>(
          `select reserved_minor from wallets where id = $1 for update`, [payout.wallet_id],
        );
        if (wallet) {
          const amount = Number(payout.amount_minor);
          const newReserved = Math.max(Number(wallet.reserved_minor) - amount, 0);
          await c.query(
            `update wallets set reserved_minor = $2, lifetime_out_minor = lifetime_out_minor + $3, updated_at = now() where id = $1`,
            [payout.wallet_id, newReserved, amount],
          );
        }
      } else {
        await c.query(
          `update payouts set status = 'REJECTED', processed_at = now(), failure_reason = $2, approved_by = $3,
                  approved_at = now(), updated_at = now()
           where id = $1`,
          [id, b.reason ?? 'Rejected by admin', adminRowId],
        );
        // Return the reserved funds to the wallet.
        const wallet = await c.one<{ available_minor: string; reserved_minor: string }>(
          `select available_minor, reserved_minor from wallets where id = $1 for update`, [payout.wallet_id],
        );
        if (wallet) {
          const amount = Number(payout.amount_minor);
          const newBalance = Number(wallet.available_minor) + amount;
          const newReserved = Math.max(Number(wallet.reserved_minor) - amount, 0);
          await c.query(
            `insert into wallet_transactions (wallet_id, type, direction, amount_minor, currency, balance_after_minor,
                                              reference_type, reference_id, description)
             values ($1,'PAYOUT_REVERSAL','CREDIT',$2,$3,$4,'payout',$5,$6)`,
            [payout.wallet_id, amount, payout.currency, newBalance, payout.id,
              `Payout ${b.decision === 'REJECT' ? 'rejected' : 'failed'} — funds returned`],
          );
          await c.query(
            `update wallets set available_minor = $2, reserved_minor = $3, updated_at = now() where id = $1`,
            [payout.wallet_id, newBalance, newReserved],
          );
        }
      }

      await recordAction(client, auth.userId, `PAYOUT_${b.decision}`, 'payout', id,
        { status: 'REQUESTED' }, { status: b.decision === 'APPROVE' ? 'PAID' : 'REJECTED' }, b.reason);

      return { id, status: b.decision === 'APPROVE' ? 'PAID' : 'REJECTED' };
    });
    logEvent(LOG_EVENTS.ADMIN_ACTION, { adminId: auth.userId, action: `PAYOUT_${b.decision}`, entityId: id });
    return reply.send({ success: true, data: result });
  });

  // -------- settings & catalog management -------------------------------
  app.get('/admin/settings', {
    preHandler: settingsRead,
    schema: { tags: ['admin'], summary: 'All platform settings', security: [{ bearerAuth: [] }] },
  }, async (_request, reply) => {
    const rows = await queryMany(`select key, value, description, is_public, updated_at from settings order by key`);
    return reply.send({ success: true, data: rows });
  });

  app.put('/admin/settings/:key', {
    preHandler: settingsWrite,
    schema: {
      tags: ['admin'], summary: 'Update a platform setting', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['key'], properties: { key: { type: 'string', maxLength: 100 } } },
      body: {
        type: 'object', required: ['value'], additionalProperties: false,
        properties: { value: {} },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { key } = request.params as { key: string };
    const { value } = request.body as { value: unknown };

    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const before = await c.one<{ value: unknown }>('select value from settings where key = $1 for update', [key]);
      if (!before) throw notFound('Setting');
      await c.query(`update settings set value = $2::jsonb, updated_at = now() where key = $1`, [key, JSON.stringify(value)]);
      await recordAction(client, auth.userId, 'UPDATE_SETTING', 'setting', key, before, { value });
      return { key, value };
    });
    return reply.send({ success: true, data: result });
  });

  // ---- Feature flags -------------------------------------------------
  // The `feature_flags` table existed but nothing exposed it, so an operator
  // had to edit the database by hand to turn a module on or off. These two
  // endpoints make the table the switchboard it was designed to be.

  app.get('/admin/feature-flags', {
    preHandler: settingsRead,
    schema: { tags: ['admin'], summary: 'All feature flags', security: [{ bearerAuth: [] }] },
  }, async (_request, reply) => {
    const rows = await queryMany(
      `select key, enabled, rollout_percent, description, updated_at
         from feature_flags order by key`,
    );
    return reply.send({ success: true, data: rows });
  });

  app.put('/admin/feature-flags/:key', {
    preHandler: settingsWrite,
    schema: {
      tags: ['admin'], summary: 'Enable or disable a feature flag', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['key'], properties: { key: { type: 'string', maxLength: 100 } } },
      body: {
        type: 'object', required: ['enabled'], additionalProperties: false,
        properties: {
          enabled: { type: 'boolean' },
          // Rollout is a percentage so a flag can be enabled for a slice of
          // traffic; 100 means everyone.
          rolloutPercent: { type: 'integer', minimum: 0, maximum: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { key } = request.params as { key: string };
    const { enabled, rolloutPercent } = request.body as { enabled: boolean; rolloutPercent?: number };

    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const before = await c.one<{ enabled: boolean; rollout_percent: number }>(
        'select enabled, rollout_percent from feature_flags where key = $1 for update',
        [key],
      );
      if (!before) throw notFound('Feature flag');

      // Only touch rollout when it was supplied, so a plain on/off switch
      // never silently resets a staged rollout someone configured on purpose.
      const next = await c.one<{ key: string; enabled: boolean; rollout_percent: number }>(
        `update feature_flags
            set enabled = $2,
                rollout_percent = coalesce($3, rollout_percent),
                updated_at = now()
          where key = $1
          returning key, enabled, rollout_percent`,
        [key, enabled, rolloutPercent ?? null],
      );

      await recordAction(client, auth.userId, 'UPDATE_FEATURE_FLAG', 'feature_flag', key, before, next);
      return next;
    });
    return reply.send({ success: true, data: result });
  });

  // ---- Accounts & verification ---------------------------------------
  // One place to see who is on the platform and to flip the three checks an
  // operator actually cares about: email, WhatsApp (a verified phone a human
  // reached on WhatsApp) and identity. Email/phone state lives on `users`;
  // identity is a `verification_records` row of type IDENTITY. WhatsApp is a
  // phone check, so it records as PHONE and is flagged `channel: 'WHATSAPP'`
  // in the record payload so the two can be told apart later.

  const VERIFICATION_KINDS = ['EMAIL', 'WHATSAPP', 'IDENTITY'] as const;
  type VerificationKind = (typeof VERIFICATION_KINDS)[number];

  app.get('/admin/accounts', {
    preHandler: usersRead,
    schema: { tags: ['admin'], summary: 'Accounts with their verification state', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const pageReq = parsePagination(request.query as Record<string, unknown>);
    const { page, limit, offset } = pageReq;
    const q = (request.query as Record<string, unknown>).q as string | undefined;
    const role = (request.query as Record<string, unknown>).role as string | undefined;

    const where: string[] = ['u.deleted_at is null'];
    const params: unknown[] = [];
    if (q) { params.push(`%${q}%`); where.push(`(u.email ilike $${params.length} or u.phone ilike $${params.length} or up.display_name ilike $${params.length})`); }
    if (role) { params.push(role); where.push(`u.role = $${params.length}::bidly_user_role`); }

    const rows = await queryMany(
      `select u.id, u.email, u.phone, u.role, u.status, u.locale, u.created_at, u.last_login_at,
              (u.email_verified_at is not null) as email_verified,
              (u.phone_verified_at is not null) as phone_verified,
              up.display_name,
              p.id as provider_id, p.verification_status,
              exists (
                select 1 from verification_records vr
                 where vr.user_id = u.id and vr.type = 'IDENTITY' and vr.status = 'VERIFIED'
              ) as identity_verified,
              exists (
                select 1 from verification_records vr
                 where vr.user_id = u.id and vr.type = 'PHONE' and vr.status = 'VERIFIED'
                   and vr.payload->>'channel' = 'WHATSAPP'
              ) as whatsapp_verified
         from users u
         left join user_profiles up on up.user_id = u.id
         left join providers p on p.user_id = u.id
        where ${where.join(' and ')}
        order by u.created_at desc
        limit ${limit} offset ${offset}`,
      params,
    );

    const total = await queryOne<{ count: number }>(
      `select count(*)::int as count from users u
         left join user_profiles up on up.user_id = u.id
        where ${where.join(' and ')}`,
      params,
    );

    return reply.send({ success: true, data: { items: rows, meta: pageMeta(pageReq, total?.count ?? 0) } });
  });

  app.put('/admin/accounts/:id/verify/:kind', {
    preHandler: usersWrite,
    schema: {
      tags: ['admin'], summary: 'Enable or disable an account verification', security: [{ bearerAuth: [] }],
      params: {
        type: 'object', required: ['id', 'kind'],
        properties: { id: { type: 'string' }, kind: { type: 'string', enum: [...VERIFICATION_KINDS] } },
      },
      body: {
        type: 'object', required: ['enabled'], additionalProperties: false,
        properties: { enabled: { type: 'boolean' }, reason: { type: 'string', maxLength: 500 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id, kind } = request.params as { id: string; kind: VerificationKind };
    const { enabled, reason } = request.body as { enabled: boolean; reason?: string };

    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const user = await c.one<{ id: string; email: string | null; phone: string | null; email_verified_at: string | null; phone_verified_at: string | null; provider_id: string | null }>(
        `select u.id, u.email, u.phone, u.email_verified_at, u.phone_verified_at, p.id as provider_id
           from users u left join providers p on p.user_id = u.id
          where u.id = $1 and u.deleted_at is null for update of u`,
        [id],
      );
      if (!user) throw notFound('Account');

      const before = { kind, enabled: await readVerification(c, user.id, user.email_verified_at, user.phone_verified_at, kind) };

      if (kind === 'EMAIL') {
        // Turning the email check off clears the timestamp so the account
        // returns to exactly the state it had before it was ever verified.
        await c.query(`update users set email_verified_at = $2, updated_at = now() where id = $1`, [id, enabled ? new Date() : null]);
      } else if (kind === 'WHATSAPP') {
        await c.query(`update users set phone_verified_at = $2, updated_at = now() where id = $1`, [id, enabled ? new Date() : null]);
      }

      if (kind === 'IDENTITY' || kind === 'WHATSAPP') {
        const type = kind === 'IDENTITY' ? 'IDENTITY' : 'PHONE';
        const channel = kind === 'WHATSAPP' ? 'WHATSAPP' : 'IDENTITY';
        // Retire any open record for this (user, type, channel) before writing a
        // new one. On disable this is the whole job, so the check really is off
        // rather than silently satisfied by a still-open row.
        await c.query(
          `update verification_records
              set status = 'EXPIRED', reviewed_at = now(), updated_at = now()
            where user_id = $1 and type = $2::bidly_verification_type
              and coalesce(payload->>'channel', '') = $3 and status in ('PENDING','VERIFIED')`,
          [id, type, channel],
        );
        if (enabled) {
          await c.query(
            `insert into verification_records (provider_id, user_id, type, status, method, reviewed_at, reviewed_by, notes, payload)
             values ($1, $2, $3::bidly_verification_type, 'VERIFIED', 'ADMIN_MANUAL', now(), $4, $5, $6::jsonb)`,
            [user.provider_id, id, type, auth.userId, reason ?? null, JSON.stringify({ channel, by: auth.userId })],
          );
        }
      }

      const after = { kind, enabled };
      await recordAction(client, auth.userId, enabled ? 'VERIFY_ACCOUNT' : 'UNVERIFY_ACCOUNT', 'user', id, before, after, reason);
      return { id, kind, enabled };
    });

    logEvent(LOG_EVENTS.ADMIN_ACTION, { adminId: auth.userId, action: 'VERIFY_ACCOUNT', entityId: id, kind });
    return reply.send({ success: true, data: result });
  });

  /** Current state of one verification kind, used for the audit before-state. */
  async function readVerification(
    c: ReturnType<typeof clientQuery>,
    userId: string,
    emailVerifiedAt: string | null,
    phoneVerifiedAt: string | null,
    kind: VerificationKind,
  ): Promise<boolean> {
    if (kind === 'EMAIL') return emailVerifiedAt !== null;
    if (kind === 'WHATSAPP') {
      const row = await c.one(
        `select 1 as ok from verification_records
          where user_id = $1 and type = 'PHONE' and status = 'VERIFIED' and payload->>'channel' = 'WHATSAPP' limit 1`,
        [userId],
      );
      return row !== null;
    }
    const row = await c.one(
      `select 1 as ok from verification_records
        where user_id = $1 and type = 'IDENTITY' and status = 'VERIFIED' limit 1`,
      [userId],
    );
    return row !== null;
  }

  app.get('/admin/commission-rules', {
    preHandler: catalogRead,
    schema: { tags: ['admin'], summary: 'Active commission rules', security: [{ bearerAuth: [] }] },
  }, async (_request, reply) => {
    const rows = await queryMany(
      `select cr.*, c.name_en as category_name from commission_rules cr
       left join categories c on c.id = cr.category_id
       where cr.is_active = true order by cr.priority`,
    );
    return reply.send({ success: true, data: rows });
  });

  app.post('/admin/commission-rules/preview', {
    preHandler: commissionWrite,
    schema: {
      tags: ['admin'], summary: 'Preview commission for a price', security: [{ bearerAuth: [] }],
      body: {
        type: 'object', required: ['priceMinor', 'ruleId'], additionalProperties: false,
        properties: { priceMinor: { type: 'integer', minimum: 0 }, ruleId: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request, reply) => {
    const b = request.body as { priceMinor: number; ruleId: string };
    const rule = await queryOne<StoredCommissionRule>(
      `select id, category_id as "categoryId", subcategory_id as "subcategoryId",
              service_id as "serviceId", provider_id as "providerId", country_code as "countryCode",
              scope, model, percent_bps as "percentBps",
              fixed_minor::float8 as "fixedMinor",
              min_fee_minor::float8 as "minFeeMinor",
              max_fee_minor::float8 as "maxFeeMinor",
              currency, priority
       from commission_rules where id = $1`,
      [b.ruleId],
    );
    if (!rule) throw notFound('Commission rule');
    const normalized: CommissionRule = {
      model: rule.model,
      percentBps: rule.percentBps,
      fixedMinor: rule.fixedMinor,
      minFeeMinor: rule.minFeeMinor,
      maxFeeMinor: rule.maxFeeMinor,
      currency: rule.currency,
    };
    const resolved = resolveCommission(b.priceMinor, normalized.currency, normalized);
    return reply.send({ success: true, data: resolved });
  });

  // -------- money & transactions ---------------------------------------
  app.get('/admin/payments', {
    preHandler: paymentsRead,
    schema: {
      tags: ['admin'], summary: 'All payments', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          status: { type: 'string' }, method: { type: 'string' }, q: { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status) { params.push(q.status); where.push(`p.status = $${params.length}::bidly_payment_status`); }
    if (q.method) { params.push(q.method); where.push(`p.method = $${params.length}::bidly_payment_method`); }
    if (q.q) {
      params.push(`%${String(q.q)}%`);
      where.push(`(cu.email ilike $${params.length} or cprof.display_name ilike $${params.length} or p.provider_ref ilike $${params.length})`);
    }
    const rows = await queryMany(
      `select p.id, p.job_id, p.status, p.method, p.amount_minor, p.captured_minor, p.refunded_minor,
              p.commission_minor, p.currency, p.provider_name, p.provider_ref,
              p.created_at, p.captured_at, p.failed_at,
              coalesce(cprof.display_name, cu.email) as customer_name, cu.email as customer_email
       from payments p join users cu on cu.id = p.customer_id
       left join user_profiles cprof on cprof.user_id = cu.id
       ${where.length ? `where ${where.join(' and ')}` : ''}
       order by p.created_at desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows, meta: pageMeta(page, rows.length) });
  });

  app.get('/admin/payments/summary', {
    preHandler: paymentsRead,
    schema: { tags: ['admin'], summary: 'Payment KPIs', security: [{ bearerAuth: [] }] },
  }, async (_request, reply) => {
    const summary = await queryOne(
      `select
         (select coalesce(sum(amount_minor),0)::text from payments where status = 'CAPTURED') as captured_minor,
         (select coalesce(sum(refunded_minor),0)::text from payments where refunded_minor > 0) as refunded_minor,
         (select coalesce(sum(commission_minor),0)::text from payments where status in ('CAPTURED','PARTIALLY_REFUNDED')) as commission_minor,
         (select count(*)::int from payments where status = 'FAILED') as failed_count,
         (select count(*)::int from payments where status = 'CAPTURED') as captured_count,
         (select coalesce(sum(available_minor),0)::text from wallets where owner_type = 'PROVIDER') as provider_wallet_minor,
         (select coalesce(sum(available_minor),0)::text from wallets where owner_type = 'USER') as customer_wallet_minor,
         (select coalesce(sum(reserved_minor),0)::text from wallets) as reserved_minor`,
    );
    return reply.send({ success: true, data: summary });
  });

  app.get('/admin/payments/:id', {
    preHandler: paymentsRead,
    schema: {
      tags: ['admin'], summary: 'Payment detail with transactions', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const payment = await queryOne(
      `select p.*, coalesce(cprof.display_name, cu.email) as customer_name, cu.email as customer_email
       from payments p join users cu on cu.id = p.customer_id
       left join user_profiles cprof on cprof.user_id = cu.id where p.id = $1`,
      [id],
    );
    if (!payment) throw notFound('Payment');
    const transactions = await queryMany(
      `select id, type, status, provider_name, provider_ref, amount_minor, currency, error_code, error_message, created_at
       from payment_transactions where payment_id = $1 order by created_at`,
      [id],
    );
    const refunds = await queryMany(
      `select id, amount_minor, currency, status, is_partial, reason, created_at, processed_at
       from refunds where payment_id = $1 order by created_at desc`,
      [id],
    );
    return reply.send({ success: true, data: { payment, transactions, refunds } });
  });

  app.get('/admin/transactions', {
    preHandler: paymentsRead,
    schema: {
      tags: ['admin'], summary: 'Payment transaction log', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          type: { type: 'string' }, status: { type: 'string' }, jobId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.type) { params.push(q.type); where.push(`t.type = $${params.length}::bidly_txn_type`); }
    if (q.status) { params.push(q.status); where.push(`t.status = $${params.length}`); }
    if (q.jobId) { params.push(q.jobId); where.push(`t.job_id = $${params.length}`); }
    const rows = await queryMany(
      `select t.id, t.payment_id, t.job_id, t.type, t.status, t.provider_name, t.provider_ref,
              t.amount_minor, t.currency, t.error_code, t.created_at,
              p.provider_ref as payment_provider_ref
       from payment_transactions t left join payments p on p.id = t.payment_id
       ${where.length ? `where ${where.join(' and ')}` : ''}
       order by t.created_at desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows, meta: pageMeta(page, rows.length) });
  });

  app.get('/admin/wallets', {
    preHandler: paymentsRead,
    schema: {
      tags: ['admin'], summary: 'Wallets with owners', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          ownerType: { type: 'string', enum: ['USER', 'PROVIDER', 'PLATFORM'] },
        },
      },
    },
  }, async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);
    const params: unknown[] = [];
    let where = '';
    if (q.ownerType) { params.push(q.ownerType); where = `where w.owner_type = $${params.length}::bidly_wallet_owner`; }
    const rows = await queryMany(
      `select w.id, w.owner_type, w.owner_id, w.currency, w.available_minor, w.pending_minor, w.reserved_minor,
              w.lifetime_in_minor, w.lifetime_out_minor, w.is_frozen, w.updated_at,
              coalesce(up.display_name, u.email) as owner_name, u.email as owner_email
       from wallets w left join users u on u.id = w.owner_id
       left join user_profiles up on up.user_id = u.id
       ${where}
       order by w.available_minor desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows, meta: pageMeta(page, rows.length) });
  });

  app.get('/admin/wallets/:id/ledger', {
    preHandler: paymentsRead,
    schema: {
      tags: ['admin'], summary: 'Wallet ledger', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 200 } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const q = request.query as Record<string, unknown>;
    const limit = Math.min(Number(q.limit ?? 100), 200);
    const wallet = await queryOne(`select * from wallets where id = $1`, [id]);
    if (!wallet) throw notFound('Wallet');
    const entries = await queryMany(
      `select id, type, direction, amount_minor, currency, balance_after_minor, reference_type, reference_id,
              job_id, payment_id, description, created_at
       from wallet_transactions where wallet_id = $1 order by created_at desc limit $2`,
      [id, limit],
    );
    return reply.send({ success: true, data: { wallet, entries } });
  });

  app.post('/admin/wallets/:id/adjust', {
    preHandler: paymentsWrite,
    schema: {
      tags: ['admin'], summary: 'Manual wallet adjustment (ledger-backed)', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', required: ['direction', 'amountMinor', 'reason'], additionalProperties: false,
        properties: {
          direction: { type: 'string', enum: ['CREDIT', 'DEBIT'] },
          amountMinor: { type: 'integer', minimum: 1 },
          reason: { type: 'string', minLength: 5, maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = request.body as { direction: 'CREDIT' | 'DEBIT'; amountMinor: number; reason: string };

    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const wallet = await c.one<{ id: string; available_minor: string; currency: string; is_frozen: boolean }>(
        `select id, available_minor, currency, is_frozen from wallets where id = $1 for update`, [id],
      );
      if (!wallet) throw notFound('Wallet');
      if (wallet.is_frozen) throw businessRule('This wallet is frozen.');
      const current = Number(wallet.available_minor);
      const delta = b.direction === 'CREDIT' ? b.amountMinor : -b.amountMinor;
      const next = current + delta;
      if (next < 0) throw businessRule('The debit exceeds the available balance.');
      await c.query(
        `insert into wallet_transactions (wallet_id, type, direction, amount_minor, currency, balance_after_minor,
                                          reference_type, description)
         values ($1,'ADJUSTMENT',$2,$3,$4,$5,'admin_adjustment',$6)`,
        [wallet.id, b.direction, b.amountMinor, wallet.currency, next, b.reason.slice(0, 200)],
      );
      await c.query(`update wallets set available_minor = $2, updated_at = now() where id = $1`, [wallet.id, next]);
      await recordAction(client, auth.userId, 'ADJUST_WALLET', 'wallet', id,
        { availableMinor: current }, { availableMinor: next, direction: b.direction, amountMinor: b.amountMinor }, b.reason);
      return { id, availableMinor: next };
    });
    logEvent(LOG_EVENTS.ADMIN_ACTION, { adminId: auth.userId, action: 'ADJUST_WALLET', entityId: id });
    return reply.send({ success: true, data: result });
  });

  // -------- requests & catalog management ------------------------------
  app.get('/admin/requests', {
    preHandler: requestsRead,
    schema: {
      tags: ['admin'], summary: 'All requests', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          status: { type: 'string' }, q: { type: 'string', maxLength: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);
    const params: unknown[] = [];
    const where: string[] = [];
    if (q.status) { params.push(q.status); where.push(`r.status = $${params.length}::bidly_request_status`); }
    if (q.q) { params.push(`%${String(q.q)}%`); where.push(`(r.title ilike $${params.length} or r.code ilike $${params.length})`); }
    const rows = await queryMany(
      `select r.id, r.code, r.title, r.status, r.service_id, r.city_id, r.budget_min_minor, r.budget_max_minor, r.currency,
              r.published_at, r.created_at, coalesce(cuprof.display_name, cu.email) as customer_name, cu.email as customer_email,
              (select count(*)::int from offers o where o.request_id = r.id) as offer_count
       from requests r join users cu on cu.id = r.customer_id
       left join user_profiles cuprof on cuprof.user_id = cu.id
       ${where.length ? `where ${where.join(' and ')}` : ''}
       order by r.created_at desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows, meta: pageMeta(page, rows.length) });
  });

  app.post('/admin/requests/:id/cancel', {
    preHandler: jobsIntervene,
    schema: {
      tags: ['admin'], summary: 'Force-cancel a request', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', required: ['reason'], additionalProperties: false,
        properties: { reason: { type: 'string', minLength: 5, maxLength: 500 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason: string };
    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const before = await c.one<{ status: string }>('select status from requests where id = $1 for update', [id]);
      if (!before) throw notFound('Request');
      await c.query(
        `update requests set status = 'CANCELLED', cancelled_at = now(), cancellation_reason = $2, updated_at = now()
         where id = $1`,
        [id, reason.slice(0, 200)],
      );
      await recordAction(client, auth.userId, 'CANCEL_REQUEST', 'request', id, before, { status: 'CANCELLED' }, reason);
      return { id, status: 'CANCELLED' };
    });
    return reply.send({ success: true, data: result });
  });

  app.get('/admin/services', {
    preHandler: catalogRead,
    schema: {
      tags: ['admin'], summary: 'Services with activation state', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, q: { type: 'string', maxLength: 100 } },
      },
    },
  }, async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);
    const params: unknown[] = [];
    let where = '';
    if (q.q) { params.push(`%${String(q.q)}%`); where = `where s.name_en ilike $1 or s.slug ilike $1`; }
    const rows = await queryMany(
      `select s.id, s.subcategory_id, s.name_en as name, s.slug, s.is_active, s.requires_location,
              s.min_price_minor, s.max_price_minor, s.default_currency as currency, s.created_at,
              sc.name_en as subcategory_name, c.name_en as category_name
       from services s
       left join subcategories sc on sc.id = s.subcategory_id
       left join categories c on c.id = sc.category_id
       ${where}
       order by s.created_at desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows, meta: pageMeta(page, rows.length) });
  });

  app.patch('/admin/services/:id', {
    preHandler: catalogWrite,
    schema: {
      tags: ['admin'], summary: 'Update a service', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          isActive: { type: 'boolean' },
          basePriceMinor: { type: 'integer', minimum: 0 },
          requiresLocation: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = request.body as { isActive?: boolean; basePriceMinor?: number; requiresLocation?: boolean };
    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const before = await c.one<{ is_active: boolean; min_price_minor: string | null; requires_location: boolean }>(
        'select is_active, min_price_minor, requires_location from services where id = $1 for update', [id],
      );
      if (!before) throw notFound('Service');
      await c.query(
        `update services set is_active = coalesce($2, is_active),
                min_price_minor = coalesce($3, min_price_minor),
                requires_location = coalesce($4, requires_location), updated_at = now()
         where id = $1`,
        [id, b.isActive ?? null, b.basePriceMinor ?? null, b.requiresLocation ?? null],
      );
      await recordAction(client, auth.userId, 'UPDATE_SERVICE', 'service', id, before, b);
      return { id, ...b };
    });
    return reply.send({ success: true, data: result });
  });

  app.post('/admin/categories', {
    preHandler: catalogWrite,
    schema: {
      tags: ['admin'], summary: 'Create a category', security: [{ bearerAuth: [] }],
      body: {
        type: 'object', required: ['name', 'slug'], additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          slug: { type: 'string', minLength: 2, maxLength: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const b = request.body as { name: string; slug: string };
    const created = await queryOne<{ id: string }>(
      `insert into categories (name_en, slug) values ($1,$2) returning id`,
      [b.name, b.slug],
    );
    await transaction(async (client) => {
      await recordAction(client, auth.userId, 'CREATE_CATEGORY', 'category', created!.id, null, b);
    });
    return reply.status(201).send({ success: true, data: created });
  });
}
