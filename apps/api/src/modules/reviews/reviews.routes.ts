import type { FastifyInstance } from 'fastify';
import { forbidden, notFound, conflict, businessRule } from '../../core/errors.js';
import { clientQuery, queryMany, queryOne, transaction } from '../../db/pool.js';
import { pageMeta, parsePagination } from '../../core/pagination.js';
import { LOG_EVENTS, logEvent } from '../../core/logger.js';

/**
 * /reviews — two-sided ratings after a job.
 *
 * Both the customer and the provider review each other. A review may only be
 * written once per job per direction, and only after the job is completed or
 * paid. Provider aggregate rating is recomputed inside the same transaction.
 */
export async function registerReviewRoutes(app: FastifyInstance): Promise<void> {
  app.post('/reviews', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['reviews'],
      summary: 'Review a job (both directions)',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['jobId', 'rating'],
        additionalProperties: false,
        properties: {
          jobId: { type: 'string', format: 'uuid' },
          rating: { type: 'integer', minimum: 1, maximum: 5 },
          comment: { type: 'string', maxLength: 2000 },
          punctuality: { type: 'integer', minimum: 1, maximum: 5 },
          quality: { type: 'integer', minimum: 1, maximum: 5 },
          communication: { type: 'integer', minimum: 1, maximum: 5 },
          value: { type: 'integer', minimum: 1, maximum: 5 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const b = request.body as {
      jobId: string; rating: number; comment?: string;
      punctuality?: number; quality?: number; communication?: number; value?: number;
    };

    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const job = await c.one<{
        id: string; customer_id: string; provider_id: string | null; status: string; provider_user_id: string | null;
      }>(
        `select j.id, j.customer_id, j.provider_id, j.status, p.user_id as provider_user_id
         from jobs j left join providers p on p.id = j.provider_id
         where j.id = $1 for update of j`,
        [b.jobId],
      );
      if (!job) throw notFound('Job');
      if (!['COMPLETED', 'PAID', 'DELIVERED'].includes(job.status)) {
        throw businessRule('You can only review a job after it is completed.');
      }

      const isCustomer = job.customer_id === auth.userId;
      const isProvider = job.provider_user_id === auth.userId;
      if (!isCustomer && !isProvider) throw forbidden();

      const direction = isCustomer ? 'CUSTOMER' : 'PROVIDER';
      const subjectId = isCustomer ? job.provider_user_id : job.customer_id;
      if (!subjectId) throw businessRule('The job has no counterparty to review.');

      // One review per direction per job (matches the unique index).
      const existing = await c.one<{ id: string }>(
        `select id from reviews where job_id = $1 and direction = $2::bidly_actor_side`,
        [b.jobId, direction],
      );
      if (existing) throw conflict('You have already reviewed this job.');

      const review = await c.one<{ id: string }>(
        `insert into reviews (job_id, request_id, author_id, subject_id, provider_id, direction, rating, comment,
                              rating_punctuality, rating_quality, rating_communication, rating_value, is_visible)
         values ($1, (select request_id from jobs where id = $1), $2, $3, $4, $5::bidly_actor_side, $6, $7,
                 $8, $9, $10, $11, true)
         returning id`,
        [
          b.jobId, auth.userId, subjectId,
          isCustomer ? job.provider_id : null,
          direction, b.rating, b.comment ?? null,
          b.punctuality ?? null, b.quality ?? null, b.communication ?? null, b.value ?? null,
        ],
      );

      // Recompute the provider's aggregate rating atomically.
      if (isCustomer && job.provider_id) {
        await c.query(
          `update providers p set
             rating_avg = sub.avg_rating,
             rating_count = sub.cnt,
             updated_at = now()
           from (
             select round(avg(rating)::numeric, 2) as avg_rating, count(*)::int as cnt
             from reviews where subject_id = $1 and direction = 'CUSTOMER' and is_visible = true
           ) sub
           where p.id = $2`,
          [subjectId, job.provider_id],
        );
      }

      logEvent(LOG_EVENTS.REVIEW_CREATED, { userId: auth.userId, jobId: b.jobId, rating: b.rating, direction });
      return review;
    });

    return reply.status(201).send({ success: true, data: result });
  });

  app.get('/reviews/job/:jobId', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['reviews'], summary: 'Reviews for a job', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    // Only the two parties to the job (or an admin) may read a job's reviews.
    const auth = request.auth!;
    const party = await queryOne<{ ok: boolean }>(
      `select true as ok from jobs j join providers p on p.id = j.provider_id
       where j.id = $1 and (j.customer_id = $2 or p.user_id = $2 or $3 = 'ADMIN')`,
      [jobId, auth.userId, auth.role],
    );
    if (!party) throw forbidden();
    const rows = await queryMany(
      `select r.id, r.direction, r.rating, r.comment, r.tags, r.would_recommend,
              r.rating_punctuality, r.rating_quality, r.rating_communication, r.rating_value,
              r.created_at, u.id as author_id, coalesce(up.display_name, u.email) as author_name
       from reviews r join users u on u.id = r.author_id
       left join user_profiles up on up.user_id = u.id
       where r.job_id = $1 and r.is_visible = true order by r.created_at`,
      [jobId],
    );
    return reply.send({ success: true, data: rows });
  });

  app.get('/reviews/provider/:providerId', {
    schema: {
      tags: ['reviews'], summary: 'Public reviews for a provider',
      params: { type: 'object', required: ['providerId'], properties: { providerId: { type: 'string', format: 'uuid' } } },
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
      },
    },
  }, async (request, reply) => {
    const { providerId } = request.params as { providerId: string };
    const page = parsePagination(request.query as Record<string, unknown>);
    const rows = await queryMany(
      `select r.id, r.rating, r.comment, r.tags, r.would_recommend,
              r.rating_punctuality, r.rating_quality, r.rating_communication, r.rating_value,
              r.created_at, coalesce(up.display_name, u.email) as author_name,
              up.avatar_url as author_avatar_url
       from reviews r
       join providers p on p.user_id = r.subject_id
       join users u on u.id = r.author_id
       left join user_profiles up on up.user_id = u.id
       where p.id = $1 and r.direction = 'CUSTOMER' and r.is_visible = true
       order by r.created_at desc limit $2 offset $3`,
      [providerId, page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows, meta: pageMeta(page, rows.length) });
  });

  app.post('/reviews/:id/report', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['reviews'], summary: 'Report a review for moderation', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', required: ['reason'], additionalProperties: false,
        properties: { reason: { type: 'string', maxLength: 500 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason: string };
    // There is no separate `review_reports` table: a report flags the review
    // for moderation (columns live on `reviews`) and is recorded in the audit
    // log so repeated reports by different users are still traceable.
    const review = await queryOne<{ id: string }>(`select id from reviews where id = $1`, [id]);
    if (!review) throw notFound('Review');
    await transaction(async (client) => {
      const c = clientQuery(client);
      await c.query(
        `update reviews set is_flagged = true, flag_reason = coalesce($2, flag_reason), updated_at = now() where id = $1`,
        [id, reason],
      );
      await c.query(
        `insert into audit_logs (actor_id, actor_type, action, entity_type, entity_id, after_state)
         values ($1,'USER','REVIEW_REPORTED','review',$2,$3::jsonb)`,
        [auth.userId, id, JSON.stringify({ reason })],
      );
    });
    return reply.send({ success: true, data: { reported: true } });
  });
}
