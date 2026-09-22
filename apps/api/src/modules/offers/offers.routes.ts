import type { FastifyInstance } from 'fastify';
import { notFound, forbidden, businessRule, priceOutOfRange, conflict } from '../../core/errors.js';
import { clientQuery, queryMany, queryOne, transaction } from '../../db/pool.js';
import { buildPage, parsePagination } from '../../core/pagination.js';
import { LOG_EVENTS, logEvent } from '../../core/logger.js';
import { enqueue, OUTBOX_TOPICS } from '../../core/outbox.js';
import { resolveCommission } from '../../core/commission.js';
import { formatMinor } from '@bidly/money';

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

      // Commission: scoped `commission_rules` override first, otherwise the
      // tiered `commission.tiers` schedule (15% to 450 MAD, 20% above), with
      // SOS surcharge, Premium discount and first-job-free layered on top.
      const isSos = await c
        .one<{ is_sos: boolean }>('select is_sos from requests where id = $1', [offer.request_id])
        .then((r) => Boolean(r?.is_sos));
      // Premium membership is optional and may not be modelled yet; treat a
      // live boost as the same paid tier so the discounted rate still applies.
      const isPremium = await c
        .one<{ is_premium: boolean }>(
          `select (p.boosted_until is not null and p.boosted_until > now()) as is_premium
             from providers p where p.id = $1`,
          [offer.provider_id],
        )
        .then((r) => Boolean(r?.is_premium));
      const resolved = await resolveCommission(client, {
        priceMinor: price,
        serviceId: offer.service_id,
        requestId: offer.request_id,
        providerUserId: offer.provider_user_id,
        isSos,
        isPremium,
      });

      const percentBps = resolved.bps;
      const commissionMinor = resolved.commissionMinor;
      const providerNetMinor = resolved.providerNetMinor;
      const commissionSnapshot = {
        ruleId: resolved.ruleId,
        model: 'PERCENT',
        percentBps,
        commissionMinor,
        providerNetMinor,
        basis: resolved.basis,
        ...resolved.snapshot,
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

      // The DB state machine only permits RECEIVING_OFFERS -> PROVIDER_SELECTED
      // -> CONFIRMED. An offer can be accepted while the request is still
      // PUBLISHED or MATCHING (offers are allowed from those states), so step
      // it through the states it must legally pass rather than jumping straight
      // from PUBLISHED to PROVIDER_SELECTED, which the trigger rejects with
      // 23514 "Illegal request transition PUBLISHED -> PROVIDER_SELECTED".
      const st = await c.one<{ status: string }>('select status from requests where id = $1', [offer.request_id]);
      if (st?.status === 'PUBLISHED') {
        await c.query(`update requests set status = 'MATCHING' where id = $1`, [offer.request_id]);
      }
      if (st?.status === 'PUBLISHED' || st?.status === 'MATCHING') {
        await c.query(
          `update requests set status = 'RECEIVING_OFFERS', matched_at = coalesce(matched_at, now()) where id = $1`,
          [offer.request_id],
        );
      }

      await c.query(
        `update requests set status = 'PROVIDER_SELECTED', selected_offer_id = $2, job_id = $3 where id = $1`,
        [offer.request_id, offer.id, job.id],
      );

      // Accepting an offer is both transitions in one atomic operation: the
      // provider is chosen and the job is immediately confirmed.
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
        // The customer is taken straight into a chat with the chosen craftsman,
        // so the accepted offer hands back the counterpart's user id.
        providerUserId: offer.provider_user_id,
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

  // -------- agree ------------------------------------------------------
  //
  // The two sides confirm the deal they negotiated. Agreeing is the moment the
  // platform is owed its commission, so it is charged here and not at payment
  // capture: the commission is debited from the provider's wallet straight away
  // (15% by default, e.g. 1500 minor out of a 10000 minor / 100 MAD offer).
  //
  // Idempotent by design: `commission_charged_at` on the job is the guard, so a
  // retry, a double tap or a stale client cannot charge the wallet twice.
  app.post('/offers/:id/agree', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['offers'], summary: 'Confirm agreement; charges the platform commission',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, properties: {} },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };

    const result = await transaction(async (client) => {
      const c = clientQuery(client);

      const offer = await c.one<{
        id: string; request_id: string; status: string; price_minor: string; currency: string;
        customer_id: string; provider_id: string; provider_user_id: string; job_id: string | null;
      }>(
        `select o.id, o.request_id, o.status, o.price_minor, o.currency,
                r.customer_id, r.job_id, p.id as provider_id, p.user_id as provider_user_id
         from offers o
         join requests r on r.id = o.request_id
         join providers p on p.id = o.provider_id
         where o.id = $1 for update`,
        [id],
      );
      if (!offer) throw notFound('Offer');
      if (offer.status !== 'ACCEPTED') throw businessRule('Only an accepted offer can be agreed on.');

      const isCustomer = offer.customer_id === auth.userId;
      const isProvider = offer.provider_user_id === auth.userId;
      if (!isCustomer && !isProvider && auth.role !== 'ADMIN') throw forbidden();

      if (!offer.job_id) throw businessRule('This offer has no job yet.');

      const job = await c.one<{
        id: string; code: string; commission_minor: string; provider_net_minor: string; currency: string;
      }>(
        `select id, code, commission_minor, provider_net_minor, currency
         from jobs where id = $1 for update`,
        [offer.job_id],
      );
      if (!job) throw notFound('Job');

      const commissionMinor = Number(job.commission_minor);
      const currency = job.currency || offer.currency;
      const finalPriceMinor = Number(offer.price_minor);

      // The ledger row is the charge record, so its presence is the guard: the
      // `PLATFORM_COMMISSION` entry for this job exists at most once, which
      // makes a retry or a double tap a no-op instead of a second debit.
      const already = await c.one<{ id: string }>(
        `select wt.id from wallet_transactions wt
         where wt.job_id = $1 and wt.type = 'PLATFORM_COMMISSION'
         limit 1`,
        [job.id],
      );
      if (already) {
        const wallet = await c.one<{ available_minor: string }>(
          `select available_minor from wallets
           where owner_type = 'PROVIDER' and owner_id = $1 and currency = $2`,
          [offer.provider_user_id, currency],
        );
        return {
          jobId: job.id, jobCode: job.code, alreadyCharged: true,
          commissionMinor, providerNetMinor: Number(job.provider_net_minor),
          finalPriceMinor, currency,
          walletBalanceMinor: wallet ? Number(wallet.available_minor) : null,
        };
      }

      // The provider pays the commission. A frozen or short wallet must fail the
      // whole agreement rather than leave a job confirmed and unpaid.
      const wallet = await c.one<{ id: string; available_minor: string; is_frozen: boolean }>(
        `insert into wallets (owner_type, owner_id, currency) values ('PROVIDER', $1, $2)
         on conflict (owner_type, owner_id, currency) do update set updated_at = now()
         returning id, available_minor, is_frozen`,
        [offer.provider_user_id, currency],
      );
      if (!wallet) throw notFound('Wallet');
      if (wallet.is_frozen) throw businessRule('The provider wallet is frozen.');

      const balanceMinor = Number(wallet.available_minor);
      if (balanceMinor < commissionMinor) {
        // Amounts are stored in minor units; the message is for a human, so
        // both figures are rendered as real currency (1800 minor -> 18.00 MAD).
        throw businessRule(
          `The provider wallet does not cover the commission of ${formatMinor(commissionMinor, currency)} ` +
          `(balance ${formatMinor(balanceMinor, currency)}).`,
        );
      }

      // Insert the ledger row only: the validate/apply triggers own the balance,
      // and `balance_after_minor` must be the value before this movement.
      const afterMinor = balanceMinor - commissionMinor;
      await c.query(
        `insert into wallet_transactions (wallet_id, type, direction, amount_minor, currency, balance_after_minor,
                                          reference_type, reference_id, job_id, description)
         values ($1,'PLATFORM_COMMISSION','DEBIT',$2,$3,$4,'job',$5,$5,$6)`,
        [
          wallet.id, commissionMinor, currency, afterMinor, job.id,
          `Platform commission for job ${job.code}`,
        ],
      );

      // Commission is already recorded on the job from the accept step; this
      // row is the platform's revenue view of the same charge.
      await c.query(
        `insert into platform_earnings (job_id, currency, gross_minor, commission_minor)
         values ($1, $2, $3, $4)`,
        [job.id, currency, finalPriceMinor, commissionMinor],
      );

      // `actor_role` and `side` are two different enums, so they must not share
      // one placeholder: Postgres deduces a single type per parameter and
      // rejects `$4` feeding both (`inconsistent types deduced for parameter $4`).
      await c.query(
        `insert into negotiations (request_id, offer_id, root_offer_id, actor_id, actor_role, side, type, price_minor, currency, resulting_offer_id, payload)
         values ($1,$2,$2,$3,$4::bidly_actor_role,$5::bidly_actor_side,'SYSTEM',$6,$7,$2,$8::jsonb)`,
        [
          offer.request_id, offer.id, auth.userId,
          isCustomer ? 'CUSTOMER' : 'PROVIDER',
          isCustomer ? 'CUSTOMER' : 'PROVIDER',
          finalPriceMinor, currency,
          JSON.stringify({ event: 'AGREEMENT', commissionMinor, walletBalanceMinor: afterMinor }),
        ],
      );

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
            status: 'AGREED',
            commissionMinor,
            recipients: [
              { userId: offer.customer_id, role: 'CUSTOMER' },
              { userId: offer.provider_user_id, role: 'PROVIDER' },
            ],
          },
        },
        client,
      );

      logEvent(LOG_EVENTS.OFFER_ACCEPTED, {
        userId: auth.userId, offerId: offer.id, jobId: job.id, commissionMinor,
      });

      return {
        jobId: job.id,
        jobCode: job.code,
        alreadyCharged: false,
        commissionMinor,
        providerNetMinor: Number(job.provider_net_minor),
        finalPriceMinor,
        currency,
        walletBalanceMinor: afterMinor,
      };
    });

    return reply.status(201).send({ success: true, data: result });
  });
}
