import type { FastifyInstance } from 'fastify';
import { notFound, businessRule, forbidden } from '../../core/errors.js';
import { clientQuery, queryMany, queryOne, transaction } from '../../db/pool.js';
import { parsePagination, pageMeta } from '../../core/pagination.js';
import { logEvent, LOG_EVENTS } from '../../core/logger.js';

/**
 * /support — customer support tickets and the help content.
 */

// Public: help centre content is readable without an account.
export async function registerSupportPublicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/support/faq', {
    schema: {
      tags: ['support'], summary: 'Published FAQ articles',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          locale: { type: 'string', maxLength: 5 },
          category: { type: 'string', maxLength: 60 },
        },
      },
    },
  }, async (request, reply) => {
    const q = request.query as { locale?: string; category?: string };
    const params: unknown[] = [];
    const where = [`is_published = true`];
    if (q.locale) { params.push(q.locale); where.push(`locale = $${params.length}`); }
    if (q.category) { params.push(q.category); where.push(`category = $${params.length}`); }
    const rows = await queryMany(
      `select id, slug, locale, category, question, answer, sort_order
       from faq_articles where ${where.join(' and ')} order by sort_order, question`,
      params,
    );
    return reply.send({ success: true, data: rows });
  });
}

export async function registerSupportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/support/tickets', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['support'],
      summary: 'Open a support ticket',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['subject', 'message'],
        additionalProperties: false,
        properties: {
          subject: { type: 'string', minLength: 3, maxLength: 200 },
          message: { type: 'string', minLength: 5, maxLength: 4000 },
          category: {
            type: 'string',
            enum: ['ACCOUNT', 'PAYMENT', 'JOB', 'TECHNICAL', 'SAFETY', 'OTHER'],
          },
          priority: { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
          jobId: { type: 'string', format: 'uuid' },
          attachmentUrl: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const b = request.body as {
      subject: string; message: string; category?: string; priority?: string; jobId?: string; attachmentUrl?: string;
    };

    const ticket = await transaction(async (client) => {
      const c = clientQuery(client);
      const row = await c.insert<{ id: string }>(
        `insert into support_tickets (user_id, subject, category, priority, job_id, status)
         values ($1,$2,coalesce($3,'OTHER'),coalesce($4,'NORMAL'),$5,'OPEN') returning id`,
        [auth.userId, b.subject, b.category ?? null, b.priority ?? null, b.jobId ?? null],
      );
      await c.query(
        `insert into support_messages (ticket_id, sender_id, sender_role, body, attachment_url)
         values ($1,$2,$3,$4,$5)`,
        [row.id, auth.userId, 'USER', b.message, b.attachmentUrl ?? null],
      );
      logEvent(LOG_EVENTS.SUPPORT_TICKET_CREATED, { userId: auth.userId, ticketId: row.id, category: b.category });
      return row;
    });

    return reply.status(201).send({ success: true, data: ticket });
  });

  app.get('/support/tickets/mine', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['support'], summary: 'My support tickets', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const page = parsePagination(request.query as Record<string, unknown>);
    const rows = await queryMany(
      `select id, subject, category, priority, status, created_at, updated_at, closed_at
       from support_tickets where user_id = $1 order by created_at desc limit $2 offset $3`,
      [auth.userId, page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows, meta: pageMeta(page, rows.length) });
  });

  app.get('/support/tickets/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['support'], summary: 'Ticket detail + messages', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const ticket = await queryOne<Record<string, unknown>>(
      `select * from support_tickets where id = $1`, [id],
    );
    if (!ticket) throw notFound('Ticket');
    if (ticket.user_id !== auth.userId && auth.role !== 'ADMIN') throw forbidden();
    const messages = await queryMany(
      `select m.id, m.sender_id, m.sender_role, m.body, m.attachment_url, m.created_at,
              u.display_name as sender_name
       from support_messages m left join users u on u.id = m.sender_id
       where m.ticket_id = $1 and m.is_internal = false order by m.created_at`,
      [id],
    );
    return reply.send({ success: true, data: { ticket, messages } });
  });

  app.post('/support/tickets/:id/messages', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['support'], summary: 'Reply to a ticket', security: [{ bearerAuth: [] }],
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
    const ticket = await queryOne<{ user_id: string; status: string }>(
      `select user_id, status from support_tickets where id = $1`, [id],
    );
    if (!ticket) throw notFound('Ticket');
    if (ticket.user_id !== auth.userId && auth.role !== 'ADMIN') throw forbidden();
    if (['CLOSED', 'RESOLVED'].includes(ticket.status)) throw businessRule('This ticket is closed.');

    const row = await queryOne(
      `insert into support_messages (ticket_id, sender_id, sender_role, body, attachment_url)
       values ($1,$2,$3,$4,$5) returning id, body, created_at`,
      [id, auth.userId, auth.role === 'ADMIN' ? 'ADMIN' : 'USER', b.message, b.attachmentUrl ?? null],
    );
    await queryOne(
      `update support_tickets set status = case when status = 'OPEN' then 'PENDING_USER' else status end,
              updated_at = now() where id = $1 returning id`,
      [id],
    );
    return reply.status(201).send({ success: true, data: row });
  });

  app.post('/support/tickets/:id/close', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['support'], summary: 'Close my ticket', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const row = await queryOne(
      `update support_tickets set status = 'CLOSED', closed_at = now(), updated_at = now()
       where id = $1 and user_id = $2 returning id, status`,
      [id, auth.userId],
    );
    if (!row) throw notFound('Ticket');
    return reply.send({ success: true, data: row });
  });
}
