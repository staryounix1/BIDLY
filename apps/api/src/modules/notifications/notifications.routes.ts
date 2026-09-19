import type { FastifyInstance } from 'fastify';
import { notFound } from '../../core/errors.js';
import { queryMany, queryOne, transaction, clientQuery } from '../../db/pool.js';
import { parsePagination } from '../../core/pagination.js';

/**
 * /notifications — the in-app notification centre.
 *
 * Rows are produced by the outbox worker from domain events (see
 * `core/outbox.ts`). The client reads them here and marks them read.
 * Push/email/SMS delivery is a provider concern handled by that same worker,
 * never by the request path.
 *
 * Columns are localised in the schema (`title_en/fr/ar`, `body_en/fr/ar`), so
 * the reader picks the caller's locale and falls back to English. `is_read` is
 * the indexed flag; `read_at` is the timestamp that goes with it — both are
 * kept in step here.
 */
export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/notifications', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['notifications'], summary: 'My notifications', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          unreadOnly: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);
    const params: unknown[] = [auth.userId];
    let where = 'user_id = $1';
    if (q.unreadOnly) where += ' and is_read = false';

    const rows = await queryMany(
      `select id, type,
              coalesce(title_en) as title_en, coalesce(title_fr) as title_fr, coalesce(title_ar) as title_ar,
              body_en, body_fr, body_ar,
              data, channel, is_read, read_at, reference_type, reference_id, created_at
       from notifications where ${where}
       order by created_at desc limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    const unread = await queryOne<{ count: string }>(
      `select count(*)::text as count from notifications where user_id = $1 and is_read = false`,
      [auth.userId],
    );
    return reply.send({
      success: true,
      data: rows,
      meta: { ...page, unread: Number(unread?.count ?? 0) },
    });
  });

  app.get('/notifications/unread-count', {
    preHandler: [app.authenticate],
    schema: { tags: ['notifications'], summary: 'My unread notification count', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const auth = request.auth!;
    const unread = await queryOne<{ count: string }>(
      `select count(*)::text as count from notifications where user_id = $1 and is_read = false`,
      [auth.userId],
    );
    return reply.send({ success: true, data: { unread: Number(unread?.count ?? 0) } });
  });

  app.post('/notifications/:id/read', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['notifications'], summary: 'Mark one notification read', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const row = await queryOne(
      `update notifications set is_read = true, read_at = coalesce(read_at, now()), status = 'READ'
       where id = $1 and user_id = $2 returning id, is_read, read_at`,
      [id, auth.userId],
    );
    if (!row) throw notFound('Notification');
    return reply.send({ success: true, data: row });
  });

  app.post('/notifications/read-all', {
    preHandler: [app.authenticate],
    schema: { tags: ['notifications'], summary: 'Mark all notifications read', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const auth = request.auth!;
    const count = await transaction(async (client) => {
      const rows = await clientQuery(client).many<{ id: string }>(
        `update notifications set is_read = true, read_at = coalesce(read_at, now()), status = 'READ'
         where user_id = $1 and is_read = false returning id`,
        [auth.userId],
      );
      return rows.length;
    });
    return reply.send({ success: true, data: { allRead: true, updated: count } });
  });

  /**
   * Preferences. The schema keys preferences by `event_type` with per-channel
   * booleans; the API surface keeps the flatter `{channel, category}` shape it
   * already published, mapping category onto event_type and channel onto the
   * matching boolean column.
   */
  app.get('/notifications/preferences', {
    preHandler: [app.authenticate],
    schema: { tags: ['notifications'], summary: 'My notification preferences', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const auth = request.auth!;
    const rows = await queryMany(
      `select id, event_type, in_app, push, email, sms from notification_preferences where user_id = $1`,
      [auth.userId],
    );
    return reply.send({ success: true, data: rows });
  });

  app.put('/notifications/preferences', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['notifications'], summary: 'Update a notification preference', security: [{ bearerAuth: [] }],
      body: {
        type: 'object', required: ['channel', 'category', 'enabled'], additionalProperties: false,
        properties: {
          channel: { type: 'string', enum: ['PUSH', 'EMAIL', 'SMS', 'IN_APP'] },
          category: { type: 'string', maxLength: 60 },
          enabled: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const b = request.body as { channel: string; category: string; enabled: boolean };
    const column =
      b.channel === 'IN_APP' ? 'in_app' : b.channel === 'PUSH' ? 'push' : b.channel === 'EMAIL' ? 'email' : 'sms';
    const row = await queryOne(
      `insert into notification_preferences (user_id, event_type, ${column})
       values ($1,$2,$3)
       on conflict (user_id, event_type)
       do update set ${column} = excluded.${column}, updated_at = now()
       returning id, event_type, in_app, push, email, sms`,
      [auth.userId, b.category, b.enabled],
    );
    return reply.send({ success: true, data: row });
  });
}
