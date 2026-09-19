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
         where j.id = $1 for update`,
        [b.jobId],
      );
      if (!job) throw notFound('Job');
      if (!['COMPLETED', 'PAID', 'DELIVERED'].includes(job.status)) {
        throw businessRule('You can only review a job after it is completed.');
      }

      const isCustomer = job.customer_id === auth.userId;
      const isProvider = job.provider_user_id === auth.userId;
      if (!isCustomer && !isProvider) throw forbidden();

      const direction = isCustomer ? 'CUSTOMER_TO_PROVIDER' : 'PROVIDER_TO_CUSTOMER';
      const revieweeId = isCustomer ? job.provider_user_id : job.customer_id;
      if (!revieweeId) throw businessRule('The job has no counterparty to review.');

      const existing = await c.one<{ id: string }>(
        `select id from reviews where job_id = $1 and author_id = $2`,
        [b.jobId, auth.userId],
      );
      if (existing) throw conflict('You have already reviewed this job.');

      const review = await c.one<{ id: string }>(
        `insert into reviews (job_id, author_id, reviewee_id, direction, rating, comment,
                              punctuality, quality, communication, value, is_visible)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) returning id`,
        [
          b.jobId, auth.userId, revieweeId, direction, b.rating, b.comment ?? null,
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
             from reviews where reviewee_id = $1 and direction = 'CUSTOMER_TO_PROVIDER' and is_visible = true
           ) sub
           where p.id = $2`,
          [revieweeId, job.provider_id],
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
    const rows = await queryMany(
      `select r.id, r.direction, r.rating, r.comment, r.punctuality, r.quality, r.communication, r.value,
              r.created_at, u.id as author_id, u.display_name as author_name
       from reviews r join users u on u.id = r.author_id
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
      `select r.id, r.rating, r.comment, r.punctuality, r.quality, r.communication, r.value,
              r.created_at, u.display_name as author_name, u.avatar_url as author_avatar_url
       from reviews r
       join providers p on p.user_id = r.reviewee_id
       join users u on u.id = r.author_id
       where p.id = $1 and r.direction = 'CUSTOMER_TO_PROVIDER' and r.is_visible = true
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
    await queryOne(
      `insert into review_reports (review_id, reporter_id, reason) values ($1,$2,$3)
       on conflict (review_id, reporter_id) do nothing returning id`,
      [id, auth.userId, reason],
    );
    return reply.send({ success: true, data: { reported: true } });
  });
}
