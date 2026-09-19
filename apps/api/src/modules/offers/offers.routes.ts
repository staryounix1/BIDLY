import type { FastifyInstance } from 'fastify';
import { notFound, forbidden, businessRule, priceOutOfRange, conflict } from '../../core/errors.js';
import { clientQuery, queryMany, queryOne, transaction } from '../../db/pool.js';
import { buildPage, parsePagination } from '../../core/pagination.js';
import { LOG_EVENTS, logEvent } from '../../core/logger.js';
import { enqueue, OUTBOX_TOPICS } from '../../core/outbox.js';

/**
 * /offers — provider bids and the negotiation thread.
 *
 * Guarantees:
 *  - eligibility is re-checked server-side on every offer
 *  - price bounds from the service and the provider's own range are enforced
 *  - negotiation history is append-only; a counter-offer always creates a new
 *    offer row, never overwrites the previous one
 *  - accepting an offer creates the job, updates the request, marks other
 *    offers, and creates the payment intent — all in one transaction
 */
export async function registerOfferRoutes(app: FastifyInstance): Promise<void> {
  // -------- create an offer -------------------------------------------
  app.post('/offers', {
    preHandler: [app.requireProvider],
    schema: {
      tags: ['offers'],
      summary: 'Submit an offer on a request',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['requestId', 'priceMinor'],
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', format: 'uuid' },
          priceMinor: { type: 'integer', minimum: 0 },
          message: { type: 'string', maxLength: 1000 },
          etaMinutes: { type: 'integer', minimum: 0, maximum: 10080 },
          availabilityStartsAt: { type: 'string' },
          estimatedDurationMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
          priceIncludesMaterials: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const b = request.body as Record<string, any>;

    const created = await transaction(async (client) => {
      const c = clientQuery(client);

      const provider = await c.one<{ id: string; currency: string; verification_status: string; status: string }>(
        'select id, currency, verification_status, status from providers where user_id = $1 and deleted_at is null',
        [auth.userId],
      );
      if (!provider) throw notFound('Provider profile');
      if (provider.status !== 'ACTIVE') throw businessRule('Your provider account is not active yet.');

      const req = await c.one<{
        id: string; status: string; customer_id: string; service_id: string;
        currency: string; expires_at: Date | null; offer_count: number;
        max_price_minor: number | null; min_price_minor: number | null; pricing_model: string;
      }>(
        `select r.id, r.status, r.customer_id, r.service_id, r.currency, r.expires_at, r.offer_count,
                s.max_price_minor, s.min_price_minor, s.pricing_model
         from requests r join services s on s.id = r.service_id
         where r.id = $1 and r.deleted_at is null for update`,
        [b.requestId],
      );
      if (!req) throw notFound('Request');
      if (req.customer_id === auth.userId) throw businessRule('You cannot offer on your own request.');
      if (!['PUBLISHED', 'MATCHING', 'RECEIVING_OFFERS'].includes(req.status)) {
        throw businessRule('This request is no longer accepting offers.');
      }
      if (req.expires_at && req.expires_at.getTime() <= Date.now()) {
        throw businessRule('This request has expired.');
      }

      const eligible = await c.one<{ id: string; min_price_minor: number | null; max_price_minor: number | null; is_active: boolean }>(
        'select id, min_price_minor, max_price_minor, is_active from provider_services where provider_id = $1 and service_id = $2',
        [provider.id, req.service_id],
      );
      if (!eligible || !eligible.is_active) {
        throw forbidden('You do not offer this service.');
      }

      const price = Number(b.priceMinor);
      const lower = eligible.min_price_minor ?? req.min_price_minor ?? null;
      const upper = eligible.max_price_minor ?? req.max_price_minor ?? null;
      if (lower != null && price < Number(lower)) throw priceOutOfRange(lower, upper);
      if (upper != null && price > Number(upper)) throw priceOutOfRange(lower, upper);

      const limitRow = await c.one<{ value: unknown }>(`select value from settings where key = 'requests.max_offers_per_request'`);
      const maxOffers = Number(limitRow?.value ?? 25);
      if (req.offer_count >= maxOffers) {
        throw businessRule('The maximum number of offers for this request has been reached.');
      }

      const existingPending = await c.one<{ id: string }>(
        `select id from offers where request_id = $1 and provider_id = $2 and status = 'PENDING'`,
        [req.id, provider.id],
      );
      if (existingPending) {
        throw conflict('You already have an active offer on this request. Update or withdraw it first.');
      }

      const offer = await c.one(
        `insert into offers (
            request_id, provider_id, price_minor, currency, message, eta_minutes,
            availability_starts_at, estimated_duration_minutes, price_includes_materials,
            status, expires_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,false),'PENDING',
                   now() + (coalesce((select (value)::text from settings where key='requests.offer_expiry_minutes'),'30') || ' minutes')::interval)
         returning *`,
        [
          req.id, provider.id, price, req.currency, b.message ?? null, b.etaMinutes ?? null,
          b.availabilityStartsAt ?? null, b.estimatedDurationMinutes ?? null,
          b.priceIncludesMaterials ?? false,
        ],
      );
      if (!offer) throw notFound('Offer');

      await c.query(
        `insert into negotiations (request_id, offer_id, root_offer_id, actor_id, actor_role, side, type, price_minor, currency, message, round_number)
         values ($1,$2,$2,$3,'PROVIDER','PROVIDER','COUNTER',$4,$5,$6,1)`,
        [req.id, (offer as { id: string }).id, auth.userId, price, req.currency, b.message ?? null],
      );

      await c.query('update match_candidates set notified_at = coalesce(notified_at, now()) where request_id = $1 and provider_id = $2', [
        req.id, provider.id,
      ]);

      // The customer learns a new offer arrived; the provider's own screens
      // refresh too, so both parties are consistent without a manual reload.
      await enqueue(
        {
          topic: OUTBOX_TOPICS.OFFER_CREATED,
          aggregateType: 'OFFER',
          aggregateId: (offer as { id: string }).id,
          payload: {
            requestId: req.id,
            offerId: (offer as { id: string }).id,
            priceMinor: price,
            currency: req.currency,
            status: 'PENDING',
            title: `Offer ${((price ?? 0) / 100).toFixed(2)} ${req.currency}`,
            recipients: [
              { userId: req.customer_id, role: 'CUSTOMER' },
              { userId: auth.userId, role: 'PROVIDER' },
            ],
          },
        },
        client,
      );

      logEvent(LOG_EVENTS.OFFER_CREATED, {
        userId: auth.userId, providerId: provider.id, requestId: req.id, priceMinor: price,
      });
      return offer;
    });

    return reply.status(201).send({ success: true, data: created });
  });

  // -------- counter-offer ---------------------------------------------
  app.post('/offers/:id/counter', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['offers'],
      summary: 'Counter an offer (customer countering a provider, or vice versa)',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['priceMinor'],
        additionalProperties: false,
        properties: {
          priceMinor: { type: 'integer', minimum: 0 },
          message: { type: 'string', maxLength: 1000 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = request.body as { priceMinor: number; message?: string };

    const result = await transaction(async (client) => {
      const c = clientQuery(client);

      const offer = await c.one<{
        id: string; request_id: string; provider_id: string; price_minor: string; currency: string;
        status: string; version: number; customer_id: string; provider_user_id: string;
      }>(
        `select o.id, o.request_id, o.provider_id, o.price_minor, o.currency, o.status, o.version,
                r.customer_id, p.user_id as provider_user_id
         from offers o
         join requests r on r.id = o.request_id
         join providers p on p.id = o.provider_id
         where o.id = $1 for update`,
        [id],
      );
      if (!offer) throw notFound('Offer');
      if (offer.status !== 'PENDING' && offer.status !== 'COUNTERED') {
        throw businessRule('Only a pending offer can be countered.');
      }

      const isCustomer = offer.customer_id === auth.userId;
      const isProvider = offer.provider_user_id === auth.userId;
      if (!isCustomer && !isProvider && auth.role !== 'ADMIN') throw forbidden();

      const side = isCustomer ? 'CUSTOMER' : 'PROVIDER';
      const actorRole = isCustomer ? 'CUSTOMER' : 'PROVIDER';

      // Mark the previous offer as countered; a new offer row carries the new price.
      await c.query(`update offers set status = 'COUNTERED' where id = $1`, [offer.id]);

      const newOffer = await c.one(
        `insert into offers (request_id, provider_id, parent_offer_id, root_offer_id, version, price_minor, currency, message, status, side, is_counter)
         values ($1,$2,$3,coalesce($3::uuid, $4),$5,$6,$7,$8,'PENDING',$9,true)
         returning *`,
        [
          offer.request_id, offer.provider_id, offer.id, offer.id,
          offer.version + 1, b.priceMinor, offer.currency, b.message ?? null,
          side === 'CUSTOMER' ? 'CUSTOMER' : 'PROVIDER',
        ],
      );
      if (!newOffer) throw notFound('Offer');

      await c.query(
        `insert into negotiations (request_id, offer_id, root_offer_id, actor_id, actor_role, side, type, price_minor, previous_price_minor, currency, message, resulting_offer_id, round_number)
         values ($1,$2,$3,$4,$5,$6,'COUNTER',$7,$8,$9,$10,$11,$12)`,
        [
          offer.request_id, offer.id, offer.id, auth.userId, actorRole, side,
          b.priceMinor, Number(offer.price_minor), offer.currency, b.message ?? null,
          (newOffer as { id: string }).id, offer.version + 1,
        ],
      );

      logEvent(LOG_EVENTS.OFFER_COUNTERED, {
        userId: auth.userId, offerId: offer.id, newOfferId: (newOffer as { id: string }).id, priceMinor: b.priceMinor,
      });
      return newOffer;
    });

    return reply.status(201).send({ success: true, data: result });
  });

  // -------- accept ------------------------------------------------------
  app.post('/offers/:id/accept', {
    preHandler: [app.requireCustomer],
    schema: {
      tags: ['offers'],
      summary: 'Accept an offer; creates the job, commission snapshot and payment intent',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };

    const result = await transaction(async (client) => {
      const c = clientQuery(client);

      const offer = await c.one<{
        id: string; request_id: string; provider_id: string; price_minor: string; currency: string;
        status: string; customer_id: string; service_id: string;
        provider_user_id: string;
        commission_bps: number | null;
      }>(
        `select o.id, o.request_id, o.provider_id, o.price_minor, o.currency, o.status,
                r.customer_id, r.service_id, s.commission_bps, p.user_id as provider_user_id
         from offers o
         join requests r on r.id = o.request_id
         join services s on s.id = r.service_id
         join providers p on p.id = o.provider_id
         where o.id = $1 for update`,
        [id],
      );
      if (!offer) throw notFound('Offer');
      if (offer.customer_id !== auth.userId) throw forbidden();
      if (offer.status !== 'PENDING') throw businessRule('Only a pending offer can be accepted.');

      const req = await c.one<{ id: string; status: string; offer_count: number }>(
        'select id, status, offer_count from requests where id = $1 for update',
        [offer.request_id],
      );
      if (!req) throw notFound('Request');
      if (!['RECEIVING_OFFERS', 'PUBLISHED', 'MATCHING', 'PROVIDER_SELECTED'].includes(req.status)) {
        throw businessRule('This request is no longer open for selection.');
      }

      const already = await c.one<{ id: string }>(`select id from offers where request_id = $1 and status = 'ACCEPTED'`, [offer.request_id]);
      if (already) throw conflict('Another offer has already been accepted for this request.');

      const price = Number(offer.price_minor);

      // Commission resolution: service override > category rule > global rule.
      const rule = await c.one<{
        model: string; percent_bps: number | null; fixed_minor: string | null;
        min_fee_minor: string | null; max_fee_minor: string | null; id: string;
      }>(
        `select id, model, percent_bps, fixed_minor, min_fee_minor, max_fee_minor
         from commission_rules
         where is_active and effective_from <= now() and (effective_to is null or effective_to > now())
           and (
             (service_id = $1) or
             (service_id is null and category_id = (select category_id from requests where id = $2)) or
             (service_id is null and category_id is null and scope = 'GLOBAL')
           )
         order by
           case scope when 'SERVICE' then 1 when 'CATEGORY' then 2 when 'GLOBAL' then 3 else 4 end,
           priority desc
         limit 1`,
        [offer.service_id, offer.request_id],
      );

      const percentBps = rule?.percent_bps ?? offer.commission_bps ?? 1500;
      let commissionMinor = Math.round((price * percentBps) / 10000);
      if (rule?.fixed_minor) commissionMinor += Number(rule.fixed_minor);
      if (rule?.min_fee_minor) commissionMinor = Math.max(commissionMinor, Number(rule.min_fee_minor));
      if (rule?.max_fee_minor) commissionMinor = Math.min(commissionMinor, Number(rule.max_fee_minor));
      commissionMinor = Math.min(Math.max(commissionMinor, 0), price);

      const providerNetMinor = price - commissionMinor;
      const commissionSnapshot = {
        ruleId: rule?.id ?? null,
        model: rule?.model ?? 'PERCENT',
        percentBps,
        fixedMinor: rule?.fixed_minor ? Number(rule.fixed_minor) : 0,
        minFeeMinor: rule?.min_fee_minor ? Number(rule.min_fee_minor) : null,
        maxFeeMinor: rule?.max_fee_minor ? Number(rule.max_fee_minor) : null,
        commissionMinor,
        providerNetMinor,
        resolvedAt: new Date().toISOString(),
      };

      await c.query(`update offers set status = 'ACCEPTED' where id = $1`, [offer.id]);
      await c.query(
        `update offers set status = 'REJECTED', rejected_at = now(), rejection_reason = 'another_offer_accepted'
         where request_id = $1 and id <> $2 and status = 'PENDING'`,
        [offer.request_id, offer.id],
      );

      const job = await c.one<{ id: string; code: string }>(
        `insert into jobs (
            request_id, customer_id, provider_id, accepted_offer_id, service_id,
            final_price_minor, currency, commission_minor, commission_bps, provider_net_minor,
            commission_snapshot, status, payment_status,
            pickup_line1, pickup_city_name, pickup_lat, pickup_lng,
            destination_line1, destination_city_name, destination_lat, destination_lng,
            scheduled_at, start_otp_expires_at
         )
         select $1, r.customer_id, $2, $3, r.service_id,
                $4, $5, $6, $7, $8, $9::jsonb, 'CONFIRMED', 'PENDING',
                r.pickup_line1, r.pickup_city_name, r.pickup_lat, r.pickup_lng,
                r.destination_line1, r.destination_city_name, r.destination_lat, r.destination_lng,
                r.scheduled_at, now() + interval '24 hours'
         from requests r where r.id = $1
         returning id, code`,
        [
          offer.request_id, offer.provider_id, offer.id,
          price, offer.currency, commissionMinor, percentBps, providerNetMinor,
          JSON.stringify(commissionSnapshot),
        ],
      );
      if (!job) throw notFound('Job');

      await c.query(
        `update requests set status = 'PROVIDER_SELECTED', selected_offer_id = $2, job_id = $3 where id = $1`,
        [offer.request_id, offer.id, job.id],
      );

      // The DB state machine only allows RECEIVING_OFFERS -> PROVIDER_SELECTED
      // -> CONFIRMED. Accepting an offer is both transitions in one atomic
      // operation: the provider is chosen and the job is immediately confirmed.
      await c.query(
        `update requests set status = 'CONFIRMED' where id = $1`,
        [offer.request_id],
      );

      await c.query(
        `insert into payments (job_id, request_id, customer_id, provider_id, amount_minor, currency,
                               commission_minor, provider_net_minor, commission_snapshot, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'PENDING')`,
        [
          job.id, offer.request_id, offer.customer_id, offer.provider_id,
          price, offer.currency, commissionMinor, providerNetMinor,
          JSON.stringify(commissionSnapshot),
        ],
      );

      await c.query(
        `insert into negotiations (request_id, offer_id, root_offer_id, actor_id, actor_role, side, type, price_minor, currency, resulting_offer_id)
         values ($1,$2,$2,$3,'CUSTOMER','CUSTOMER','ACCEPT',$4,$5,$2)`,
        [offer.request_id, offer.id, auth.userId, price, offer.currency],
      );

      logEvent(LOG_EVENTS.OFFER_ACCEPTED, { userId: auth.userId, offerId: offer.id, jobId: job.id });
      logEvent(LOG_EVENTS.JOB_CREATED, { jobId: job.id, requestId: offer.request_id, priceMinor: price });

      // Both parties are told the offer was accepted and the job exists. The
      // rejected rivals are not told individually — the request-level event
      // covers their screens.
      await enqueue(
        {
          topic: OUTBOX_TOPICS.OFFER_ACCEPTED,
          aggregateType: 'OFFER',
          aggregateId: offer.id,
          payload: {
            requestId: offer.request_id,
            offerId: offer.id,
            jobId: job.id,
            jobCode: job.code,
            status: 'ACCEPTED',
            title: job.code,
            finalPriceMinor: price,
            currency: offer.currency,
            recipients: [
              { userId: auth.userId, role: 'CUSTOMER' },
              { userId: offer.provider_user_id, role: 'PROVIDER' },
            ],
          },
        },
        client,
      );
      await enqueue(
        {
          topic: OUTBOX_TOPICS.JOB_STATUS_CHANGED,
          aggregateType: 'JOB',
          aggregateId: job.id,
          payload: {
            jobId: job.id,
            jobCode: job.code,
            requestId: offer.request_id,
            status: 'CONFIRMED',
            title: job.code,
            recipients: [
              { userId: auth.userId, role: 'CUSTOMER' },
              { userId: offer.provider_user_id, role: 'PROVIDER' },
            ],
          },
        },
        client,
      );

      return {
        jobId: job.id,
        jobCode: job.code,
        finalPriceMinor: price,
        currency: offer.currency,
        commissionMinor,
        providerNetMinor,
      };
    });

    return reply.status(201).send({ success: true, data: result });
  });

  // -------- reject / withdraw ------------------------------------------
  app.post('/offers/:id/reject', {
    preHandler: [app.requireCustomer],
    schema: {
      tags: ['offers'], summary: 'Reject an offer', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = (request.body ?? {}) as { reason?: string };

    const updated = await transaction(async (client) => {
      const c = clientQuery(client);
      const offer = await c.one<{ id: string; request_id: string; status: string; customer_id: string; provider_user_id: string }>(
        `select o.id, o.request_id, o.status, r.customer_id, p.user_id as provider_user_id
         from offers o join requests r on r.id = o.request_id join providers p on p.id = o.provider_id
         where o.id = $1 for update`,
        [id],
      );
      if (!offer) throw notFound('Offer');
      if (offer.customer_id !== auth.userId) throw forbidden();
      if (offer.status !== 'PENDING' && offer.status !== 'COUNTERED') throw businessRule('This offer cannot be rejected.');

      const row = await c.one(
        `update offers set status = 'REJECTED', rejected_at = now(), rejection_reason = $2 where id = $1 returning *`,
        [id, b.reason ?? null],
      );
      await c.query(
        `insert into negotiations (request_id, offer_id, actor_id, actor_role, side, type, message)
         values ($1,$2,$3,'CUSTOMER','CUSTOMER','REJECT',$4)`,
        [offer.request_id, id, auth.userId, b.reason ?? null],
      );
      await enqueue(
        {
          topic: OUTBOX_TOPICS.OFFER_REJECTED,
          aggregateType: 'OFFER',
          aggregateId: id,
          payload: {
            requestId: offer.request_id,
            offerId: id,
            status: 'REJECTED',
            reason: b.reason ?? null,
            recipients: [
              { userId: offer.provider_user_id, role: 'PROVIDER' },
              { userId: auth.userId, role: 'CUSTOMER' },
            ],
          },
        },
        client,
      );
      logEvent(LOG_EVENTS.OFFER_REJECTED, { userId: auth.userId, offerId: id });
      return row;
    });

    return reply.send({ success: true, data: updated });
  });

  app.post('/offers/:id/withdraw', {
    preHandler: [app.requireProvider],
    schema: {
      tags: ['offers'], summary: 'Withdraw my offer', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };

    const updated = await transaction(async (client) => {
      const c = clientQuery(client);
      const offer = await c.one<{ id: string; request_id: string; status: string; provider_user_id: string; customer_id: string }>(
        `select o.id, o.request_id, o.status, p.user_id as provider_user_id, r.customer_id
         from offers o join providers p on p.id = o.provider_id join requests r on r.id = o.request_id
         where o.id = $1 for update`,
        [id],
      );
      if (!offer) throw notFound('Offer');
      if (offer.provider_user_id !== auth.userId) throw forbidden();
      if (offer.status !== 'PENDING' && offer.status !== 'COUNTERED') throw businessRule('This offer cannot be withdrawn.');

      const row = await c.one(`update offers set status = 'WITHDRAWN', withdrawn_at = now() where id = $1 returning *`, [id]);
      await c.query(
        `insert into negotiations (request_id, offer_id, actor_id, actor_role, side, type)
         values ($1,$2,$3,'PROVIDER','PROVIDER','WITHDRAW')`,
        [offer.request_id, id, auth.userId],
      );
      await enqueue(
        {
          topic: OUTBOX_TOPICS.OFFER_WITHDRAWN,
          aggregateType: 'OFFER',
          aggregateId: id,
          payload: {
            requestId: offer.request_id,
            offerId: id,
            status: 'WITHDRAWN',
            recipients: [
              { userId: offer.customer_id, role: 'CUSTOMER' },
              { userId: auth.userId, role: 'PROVIDER' },
            ],
          },
        },
        client,
      );
      logEvent(LOG_EVENTS.OFFER_WITHDRAWN, { userId: auth.userId, offerId: id });
      return row;
    });

    return reply.send({ success: true, data: updated });
  });

  // -------- my offers ---------------------------------------------------
  app.get('/offers/mine', {
    preHandler: [app.requireProvider],
    schema: {
      tags: ['offers'], summary: 'List my offers', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          status: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);
    const where = ['p.user_id = $1'];
    const params: unknown[] = [auth.userId];
    if (q.status) { params.push(q.status); where.push(`o.status = $${params.length}`); }

    const rows = await queryMany(
      `select o.*, r.code as request_code, r.title as request_title, r.status as request_status,
              s.name_en as service_name
       from offers o
       join providers p on p.id = o.provider_id
       join requests r on r.id = o.request_id
       join services s on s.id = r.service_id
       where ${where.join(' and ')} order by o.created_at desc
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    const total = await queryOne<{ count: string }>(
      `select count(*)::text as count from offers o join providers p on p.id = o.provider_id where ${where.join(' and ')}`,
      params,
    );
    return reply.send({ success: true, data: buildPage(rows, Number(total?.count ?? 0), page) });
  });

  // -------- negotiation thread ------------------------------------------
  app.get('/offers/:id/history', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['offers'], summary: 'Full negotiation history for an offer', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };

    const offer = await queryOne<{ request_id: string; customer_id: string; provider_user_id: string }>(
      `select o.request_id, r.customer_id, p.user_id as provider_user_id
       from offers o join requests r on r.id = o.request_id join providers p on p.id = o.provider_id
       where o.id = $1`,
      [id],
    );
    if (!offer) throw notFound('Offer');
    const isParty = offer.customer_id === auth.userId || offer.provider_user_id === auth.userId || auth.role === 'ADMIN';
    if (!isParty) throw forbidden();

    const history = await queryMany(
      `select * from offer_history where offer_id = $1 order by version, created_at`,
      [id],
    );
    const negotiations = await queryMany(
      `select * from negotiations where root_offer_id = $1 or offer_id = $1 order by created_at`,
      [id],
    );
    return reply.send({ success: true, data: { history, negotiations } });
  });
}
