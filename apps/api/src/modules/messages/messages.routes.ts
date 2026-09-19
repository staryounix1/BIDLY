import type { FastifyInstance } from 'fastify';
import { forbidden, notFound } from '../../core/errors.js';
import { clientQuery, queryMany, queryOne, transaction } from '../../db/pool.js';
import { buildPage, parsePagination } from '../../core/pagination.js';
import { enqueue, OUTBOX_TOPICS } from '../../core/outbox.js';

/**
 * /conversations, /messages — per-job and per-request chat.
 *
 * Access is participant-only. A per-conversation `client_id` unique index
 * makes message creation idempotent, which matters when a mobile client
 * retries after a flaky connection.
 */
export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/conversations', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['messages'], summary: 'List my conversations', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const page = parsePagination(request.query as Record<string, unknown>);

    const rows = await queryMany(
      `select c.*,
              case when c.participant_a = $1 then c.a_unread_count else c.b_unread_count end as unread_count,
              case when c.participant_a = $1 then ub.display_name else ua.display_name end as counterpart_name,
              case when c.participant_a = $1 then c.participant_b else c.participant_a end as counterpart_id
       from conversations c
       left join user_profiles ua on ua.user_id = c.participant_a
       left join user_profiles ub on ub.user_id = c.participant_b
       where (c.participant_a = $1 or c.participant_b = $1) and c.status <> 'BLOCKED'
       order by c.last_message_at desc nulls last
       limit $2 offset $3`,
      [auth.userId, page.limit, page.offset],
    );
    const total = await queryOne<{ count: string }>(
      'select count(*)::text as count from conversations where participant_a = $1 or participant_b = $1',
      [auth.userId],
    );
    return reply.send({ success: true, data: buildPage(rows, Number(total?.count ?? 0), page) });
  });

  app.post('/conversations', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['messages'], summary: 'Open (or return) a conversation for a job or request', security: [{ bearerAuth: [] }],
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          jobId: { type: 'string', format: 'uuid' },
          requestId: { type: 'string', format: 'uuid' },
          counterpartId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const b = request.body as { jobId?: string; requestId?: string; counterpartId?: string };

    const conversation = await transaction(async (client) => {
      const c = clientQuery(client);

      let counterpart = b.counterpartId ?? null;

      if (b.jobId) {
        const job = await c.one<{ customer_id: string; provider_user_id: string }>(
          `select j.customer_id, p.user_id as provider_user_id
           from jobs j join providers p on p.id = j.provider_id where j.id = $1`,
          [b.jobId],
        );
        if (!job) throw notFound('Job');
        if (job.customer_id !== auth.userId && job.provider_user_id !== auth.userId && auth.role !== 'ADMIN') throw forbidden();
        counterpart = job.customer_id === auth.userId ? job.provider_user_id : job.customer_id;
      }

      if (!counterpart) throw notFound('Counterpart');

      const existing = await c.one(
        `select * from conversations
         where ((participant_a = $1 and participant_b = $2) or (participant_a = $2 and participant_b = $1))
           and (($3::uuid is null and $4::uuid is null) or job_id = $3 or request_id = $4)
         limit 1`,
        [auth.userId, counterpart, b.jobId ?? null, b.requestId ?? null],
      );
      if (existing) return existing;

      return c.one(
        `insert into conversations (request_id, job_id, participant_a, participant_b)
         values ($1,$2,$3,$4) returning *`,
        [b.requestId ?? null, b.jobId ?? null, auth.userId, counterpart],
      );
    });

    return reply.status(201).send({ success: true, data: conversation });
  });

  app.get('/conversations/:id/messages', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['messages'], summary: 'Read messages in a conversation', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const page = parsePagination(request.query as Record<string, unknown>);

    const conversation = await queryOne<{ participant_a: string; participant_b: string }>(
      'select participant_a, participant_b from conversations where id = $1',
      [id],
    );
    if (!conversation) throw notFound('Conversation');
    if (conversation.participant_a !== auth.userId && conversation.participant_b !== auth.userId && auth.role !== 'ADMIN') {
      throw forbidden();
    }

    const rows = await queryMany(
      `select m.id, m.sender_id, m.kind, m.body, m.attachment_url, m.lat, m.lng, m.read_at, m.created_at
       from messages m where m.conversation_id = $1 and m.deleted_at is null
       order by m.created_at desc limit $2 offset $3`,
      [id, page.limit, page.offset],
    );
    return reply.send({ success: true, data: { messages: rows.reverse() } });
  });

  app.post('/conversations/:id/messages', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['messages'], summary: 'Send a message', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          body: { type: 'string', maxLength: 4000 },
          kind: { type: 'string', enum: ['TEXT', 'IMAGE', 'FILE', 'LOCATION', 'OFFER_REFERENCE'] },
          attachmentUrl: { type: 'string', maxLength: 2048 },
          lat: { type: 'number' }, lng: { type: 'number' },
          clientId: { type: 'string', maxLength: 80 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = request.body as Record<string, unknown>;

    const message = await transaction(async (client) => {
      const c = clientQuery(client);
      const conversation = await c.one<{ participant_a: string; participant_b: string }>(
        'select participant_a, participant_b from conversations where id = $1',
        [id],
      );
      if (!conversation) throw notFound('Conversation');
      if (conversation.participant_a !== auth.userId && conversation.participant_b !== auth.userId) throw forbidden();

      const row = await c.one<{ id: string }>(
        `insert into messages (conversation_id, sender_id, kind, body, attachment_url, lat, lng, client_id)
         values ($1,$2,coalesce($3::bidly_message_kind,'TEXT'),$4,$5,$6,$7,$8)
         on conflict (conversation_id, client_id) where client_id is not null do nothing
         returning *`,
        [
          id, auth.userId, b.kind ?? null, b.body ?? null,
          b.attachmentUrl ?? null, b.lat ?? null, b.lng ?? null, b.clientId ?? null,
        ],
      );
      if (!row) {
        // Idempotent retry: return the row that already exists and do not emit
        // a second event, so a flaky mobile client cannot double-notify.
        return c.one(
          `select * from messages where conversation_id = $1 and client_id = $2`,
          [id, b.clientId],
        );
      }

      const recipient =
        conversation.participant_a === auth.userId ? conversation.participant_b : conversation.participant_a;

      await enqueue(
        {
          topic: OUTBOX_TOPICS.MESSAGE_SENT,
          aggregateType: 'MESSAGE',
          aggregateId: String((row as { id: string }).id),
          payload: {
            conversationId: id,
            messageId: (row as { id: string }).id,
            senderId: auth.userId,
            kind: (row as { kind?: string }).kind ?? 'TEXT',
            body: (row as { body?: string | null }).body ?? null,
            createdAt: (row as { created_at?: string }).created_at ?? null,
            preview: typeof b.body === 'string' ? b.body.slice(0, 140) : null,
            recipients: [
              { userId: recipient, role: 'CUSTOMER' },
              { userId: auth.userId, role: 'PROVIDER' },
            ],
          },
        },
        client,
      );

      return row;
    });

    return reply.status(201).send({ success: true, data: message });
  });

  app.post('/conversations/:id/read', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['messages'], summary: 'Mark my messages in this conversation as read', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };

    await transaction(async (client) => {
      const c = clientQuery(client);
      const conversation = await c.one<{ participant_a: string; participant_b: string }>(
        'select participant_a, participant_b from conversations where id = $1',
        [id],
      );
      if (!conversation) throw notFound('Conversation');
      if (conversation.participant_a !== auth.userId && conversation.participant_b !== auth.userId) throw forbidden();

      await c.query(
        `update messages set read_at = now()
         where conversation_id = $1 and sender_id <> $2 and read_at is null`,
        [id, auth.userId],
      );
      await c.query(
        `update conversations set
           a_unread_count = case when participant_a = $2 then 0 else a_unread_count end,
           b_unread_count = case when participant_b = $2 then 0 else b_unread_count end
         where id = $1`,
        [id, auth.userId],
      );
    });

    return reply.send({ success: true, data: { read: true } });
  });
}
