import type { FastifyInstance } from 'fastify';
import { forbidden, notFound, businessRule, conflict } from '../../core/errors.js';
import { clientQuery, queryMany, queryOne, transaction } from '../../db/pool.js';
import { parsePagination, pageMeta } from '../../core/pagination.js';
import { LOG_EVENTS, logEvent } from '../../core/logger.js';

/**
 * /disputes — disagreements over a job.
 *
 * Opening a dispute freezes the job's resolution path: the customer and
 * provider can exchange messages, and an admin (or automated policy) resolves
 * it as a refund, a partial refund, a release to the provider, or dismissal.
 * Dispute events are append-only.
 */
export async function registerDisputeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/disputes', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['disputes'],
      summary: 'Open a dispute on a job',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['jobId', 'category', 'description'],
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', format: 'uuid' },
          category: {
            type: 'string',
            enum: ['NOT_AS_DESCRIBED', 'NO_SHOW', 'QUALITY', 'PRICE', 'DAMAGE', 'SAFETY', 'OTHER'],
          },
          description: { type: 'string', minLength: 10, maxLength: 4000 },
          desiredResolution: { type: 'string', maxLength: 1000 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const b = request.body as { jobId: string; category: string; description: string; desiredResolution?: string };

    const dispute = await transaction(async (client) => {
      const c = clientQuery(client);
      const job = await c.one<{
        id: string; customer_id: string; provider_id: string | null; status: string; provider_user_id: string | null;
      }>(
        `select j.id, j.customer_id, j.provider_id, j.status, j.provider_id, p.user_id as provider_user_id
         from jobs j left join providers p on p.id = j.provider_id
         where j.id = $1 for update`,
        [b.jobId],
      );
      if (!job) throw notFound('Job');

      const isCustomer = job.customer_id === auth.userId;
      const isProvider = job.provider_user_id === auth.userId;
      if (!isCustomer && !isProvider) throw forbidden();
      if (job.status === 'CANCELLED') throw businessRule('A cancelled job cannot be disputed.');
      if (job.status === 'DISPUTED') throw conflict('This job already has an open dispute.');

      const open = await c.one<{ id: string }>(
        `select id from disputes where job_id = $1 and status in ('OPEN','UNDER_REVIEW')`,
        [b.jobId],
      );
      if (open) throw conflict('This job already has an open dispute.');

      const row = await c.insert<{ id: string }>(
        `insert into disputes (job_id, opened_by, against_user_id, category, description, desired_resolution, status, priority)
         values ($1,$2,$3,$4,$5,$6,'OPEN','NORMAL') returning id`,
        [
          b.jobId, auth.userId, isCustomer ? job.provider_user_id : job.customer_id,
          b.category, b.description, b.desiredResolution ?? null,
        ],
      );

      await c.query(
        `insert into dispute_events (dispute_id, actor_id, type, note) values ($1,$2,'OPENED',$3)`,
        [row.id, auth.userId, b.description.slice(0, 500)],
      );

      await c.query(
        `update jobs set status = 'DISPUTED', disputed_at = now(), updated_at = now() where id = $1`,
        [b.jobId],
      );

      logEvent(LOG_EVENTS.DISPUTE_OPENED, { userId: auth.userId, jobId: b.jobId, disputeId: row.id, category: b.category });
      return row;
    });

    return reply.status(201).send({ success: true, data: dispute });
  });

  app.get('/disputes/mine', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['disputes'], summary: 'Disputes I am part of', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const page = parsePagination(request.query as Record<string, unknown>);
    const rows = await queryMany(
      `select d.id, d.job_id, d.category, d.status, d.priority, d.description, d.desired_resolution,
              d.resolution, d.opened_by, d.created_at, d.resolved_at,
              j.title as job_title, j.status as job_status
       from disputes d join jobs j on j.id = d.job_id
       where d.opened_by = $1 or d.against_user_id = $1
       order by d.created_at desc limit $2 offset $3`,
      [auth.userId, page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows, meta: pageMeta(page, rows.length) });
  });

  app.get('/disputes/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['disputes'], summary: 'Dispute detail + event timeline', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const dispute = await queryOne<Record<string, unknown>>(
      `select d.*, j.title as job_title, j.status as job_status, j.customer_id, j.provider_id
       from disputes d join jobs j on j.id = d.job_id where d.id = $1`,
      [id],
    );
    if (!dispute) throw notFound('Dispute');

    const providerRow = dispute.provider_id
      ? await queryOne<{ user_id: string }>('select user_id from providers where id = $1', [dispute.provider_id])
      : null;
    const involved = dispute.opened_by === auth.userId
      || dispute.against_user_id === auth.userId
      || dispute.customer_id === auth.userId
      || providerRow?.user_id === auth.userId;
    if (!involved && auth.role !== 'ADMIN') throw forbidden();

    const events = await queryMany(
      `select e.id, e.type, e.note, e.actor_id, u.display_name as actor_name, e.created_at
       from dispute_events e left join users u on u.id = e.actor_id
       where e.dispute_id = $1 order by e.created_at`,
      [id],
    );
    return reply.send({ success: true, data: { dispute, events } });
  });

  app.post('/disputes/:id/messages', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['disputes'], summary: 'Add a message to a dispute', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', required: ['message'], additionalProperties: false,
        properties: { message: { type: 'string', minLength: 1, maxLength: 4000 }, attachmentUrl: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = request.body as { message: string; attachmentUrl?: string };
    const dispute = await queryOne<{ id: string; opened_by: string; against_user_id: string | null; status: string }>(
      `select id, opened_by, against_user_id, status from disputes where id = $1`,
      [id],
    );
    if (!dispute) throw notFound('Dispute');
    if (dispute.opened_by !== auth.userId && dispute.against_user_id !== auth.userId && auth.role !== 'ADMIN') {
      throw forbidden();
    }
    if (['RESOLVED', 'CLOSED', 'CANCELLED'].includes(dispute.status)) {
      throw businessRule('This dispute is closed to new messages.');
    }
    const row = await queryOne(
      `insert into dispute_events (dispute_id, actor_id, type, note, attachment_url)
       values ($1,$2,'MESSAGE',$3,$4) returning id, type, note, created_at`,
      [id, auth.userId, b.message, b.attachmentUrl ?? null],
    );
    return reply.status(201).send({ success: true, data: row });
  });

  app.post('/disputes/:id/escalate', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['disputes'], summary: 'Escalate a dispute for admin review', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: { reason: { type: 'string', maxLength: 1000 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = (request.body ?? {}) as { reason?: string };
    const dispute = await queryOne<{ opened_by: string; against_user_id: string | null; status: string }>(
      `select opened_by, against_user_id, status from disputes where id = $1`,
      [id],
    );
    if (!dispute) throw notFound('Dispute');
    if (dispute.opened_by !== auth.userId && dispute.against_user_id !== auth.userId) throw forbidden();
    if (!['OPEN', 'UNDER_REVIEW'].includes(dispute.status)) throw businessRule('Only open disputes can be escalated.');

    await transaction(async (client) => {
      const c = clientQuery(client);
      await c.query(`update disputes set status = 'UNDER_REVIEW', priority = 'HIGH', updated_at = now() where id = $1`, [id]);
      await c.query(`insert into dispute_events (dispute_id, actor_id, type, note) values ($1,$2,'ESCALATED',$3)`,
        [id, auth.userId, b.reason ?? 'Escalated for review']);
    });
    return reply.send({ success: true, data: { status: 'UNDER_REVIEW' } });
  });

  app.post('/disputes/:id/withdraw', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['disputes'], summary: 'Withdraw a dispute you opened', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const dispute = await queryOne<{ opened_by: string; job_id: string; status: string }>(
      `select opened_by, job_id, status from disputes where id = $1`, [id],
    );
    if (!dispute) throw notFound('Dispute');
    if (dispute.opened_by !== auth.userId) throw forbidden();
    if (!['OPEN', 'UNDER_REVIEW'].includes(dispute.status)) throw businessRule('Only an open dispute can be withdrawn.');

    await transaction(async (client) => {
      const c = clientQuery(client);
      await c.query(`update disputes set status = 'WITHDRAWN', closed_at = now(), updated_at = now() where id = $1`, [id]);
      await c.query(`insert into dispute_events (dispute_id, actor_id, type, note) values ($1,$2,'WITHDRAWN','Withdrawn by opener')`, [id, auth.userId]);
      await c.query(`update jobs set status = 'COMPLETED', updated_at = now() where id = $1 and status = 'DISPUTED'`, [dispute.job_id]);
    });
    return reply.send({ success: true, data: { status: 'WITHDRAWN' } });
  });
}
