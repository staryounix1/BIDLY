import type { FastifyInstance } from 'fastify';
import { unauthorized, notFound, forbidden, businessRule, validationError } from '../../core/errors.js';
import { clientQuery, queryMany, queryOne, transaction } from '../../db/pool.js';
import { buildPage, orderByClause, parsePagination } from '../../core/pagination.js';
import { generateHumanCode } from '../../core/tokens.js';
import { LOG_EVENTS, logEvent } from '../../core/logger.js';
import { enqueue, OUTBOX_TOPICS } from '../../core/outbox.js';

/**
 * /requests — the demand side of the marketplace.
 *
 * A customer creates a request against a database-defined service, answers
 * that service's dynamic questions, and publishes it. The state machine is
 * enforced here AND in the database.
 */
export async function registerRequestRoutes(app: FastifyInstance): Promise<void> {
  const ORDER = {
    createdAt: 'r.created_at',
    publishedAt: 'r.published_at',
    budget: 'r.budget_max_minor',
    offers: 'r.offer_count',
  };

  // -------- create (draft) -------------------------------------------
  app.post('/requests', {
    preHandler: [app.requireCustomer],
    schema: {
      tags: ['requests'],
      summary: 'Create a request (starts as DRAFT)',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['serviceId'],
        additionalProperties: false,
        properties: {
          serviceId: { type: 'string', format: 'uuid' },
          title: { type: 'string', maxLength: 140 },
          description: { type: 'string', maxLength: 2000 },
          answers: { type: 'object', additionalProperties: true },
          budgetMinMinor: { type: 'integer', minimum: 0 },
          budgetMaxMinor: { type: 'integer', minimum: 0 },
          currency: { type: 'string', minLength: 3, maxLength: 3 },
          urgency: { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
          scheduledAt: { type: 'string' },
          scheduledFlexible: { type: 'boolean' },
          itemCount: { type: 'integer', minimum: 0 },
          requiresHelper: { type: 'boolean' },
          pickup: {
            type: 'object',
            additionalProperties: false,
            properties: {
              line1: { type: 'string', maxLength: 200 },
              line2: { type: 'string', maxLength: 200 },
              district: { type: 'string', maxLength: 100 },
              cityId: { type: 'string', format: 'uuid' },
              cityName: { type: 'string', maxLength: 100 },
              lat: { type: 'number' },
              lng: { type: 'number' },
              notes: { type: 'string', maxLength: 300 },
            },
          },
          destination: {
            type: 'object',
            additionalProperties: false,
            properties: {
              line1: { type: 'string', maxLength: 200 },
              cityId: { type: 'string', format: 'uuid' },
              cityName: { type: 'string', maxLength: 100 },
              lat: { type: 'number' },
              lng: { type: 'number' },
              notes: { type: 'string', maxLength: 300 },
            },
          },
          mediaUrls: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 2048 } },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const b = request.body as Record<string, any>;
    const currency = (b.currency ?? 'MAD').toUpperCase();

    if (b.budgetMinMinor != null && b.budgetMaxMinor != null && b.budgetMaxMinor < b.budgetMinMinor) {
      throw validationError({ budget: ['budgetMaxMinor must be greater than or equal to budgetMinMinor'] });
    }

    const service = await queryOne<{
      id: string; subcategory_id: string; requires_location: boolean;
      requires_destination: boolean; pricing_model: string; default_currency: string;
    }>(
      `select s.id, s.subcategory_id, s.requires_location, s.requires_destination, s.pricing_model, s.default_currency
       from services s where s.id = $1 and s.is_active`,
      [b.serviceId],
    );
    if (!service) throw notFound('Service');

    if (service.requires_location && !b.pickup?.line1) {
      throw validationError({ pickup: ['A pickup location is required for this service.'] });
    }
    if (service.requires_destination && !b.destination?.line1) {
      throw validationError({ destination: ['A destination is required for this service.'] });
    }

    const created = await transaction(async (client) => {
      const c = clientQuery(client);

      const subcategory = await c.one<{ category_id: string }>(
        'select category_id from subcategories where id = $1',
        [service.subcategory_id],
      );
      if (!subcategory) throw notFound('Subcategory');

      const request_ = await c.one<{ id: string; code: string }>(
        `insert into requests (
            code, customer_id, category_id, subcategory_id, service_id, title, description,
            answers, status, pricing_model, budget_min_minor, budget_max_minor, currency,
            urgency, scheduled_at, scheduled_flexible, item_count, requires_helper,
            pickup_line1, pickup_line2, pickup_district, pickup_city_id, pickup_city_name,
            pickup_lat, pickup_lng, pickup_notes,
            destination_line1, destination_city_id, destination_city_name,
            destination_lat, destination_lng, destination_notes
         ) values (
            $1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9,$10,$11,$12,$13,$14,
            coalesce($15,true),$16,coalesce($17,false),
            $18,$19,$20,$21,$22,$23,$24,$25,
            $26,$27,$28,$29,$30,$31
         ) returning id, code`,
        [
          generateHumanCode('REQ'),
          auth.userId,
          subcategory.category_id,
          service.subcategory_id,
          service.id,
          b.title ?? null,
          b.description ?? null,
          JSON.stringify(b.answers ?? {}),
          service.pricing_model,
          b.budgetMinMinor ?? null,
          b.budgetMaxMinor ?? null,
          currency,
          b.urgency ?? 'NORMAL',
          b.scheduledAt ?? null,
          b.scheduledFlexible ?? true,
          b.itemCount ?? null,
          b.requiresHelper ?? false,
          b.pickup?.line1 ?? null, b.pickup?.line2 ?? null, b.pickup?.district ?? null,
          b.pickup?.cityId ?? null, b.pickup?.cityName ?? null,
          b.pickup?.lat ?? null, b.pickup?.lng ?? null, b.pickup?.notes ?? null,
          b.destination?.line1 ?? null, b.destination?.cityId ?? null, b.destination?.cityName ?? null,
          b.destination?.lat ?? null, b.destination?.lng ?? null, b.destination?.notes ?? null,
        ],
      );
      if (!request_) throw notFound('Request');

      // Normalise dynamic answers into request_answers rows
      if (b.answers && typeof b.answers === 'object') {
        const fields = await c.many<{ id: string; key: string; type: string; is_required: boolean }>(
          'select id, key, type, is_required from service_fields where service_id = $1 and is_active',
          [service.id],
        );
        const fieldByKey = new Map(fields.map((f) => [f.key, f]));

        for (const field of fields) {
          const value = (b.answers as Record<string, unknown>)[field.key];
          if (field.is_required && (value === undefined || value === null || value === '')) {
            throw validationError({ answers: [`"${field.key}" is required.`] });
          }
        }

        for (const [key, value] of Object.entries(b.answers as Record<string, unknown>)) {
          const field = fieldByKey.get(key);
          if (!field) continue;
          await c.query(
            `insert into request_answers (request_id, field_id, field_key, field_type, value_text, value_number, value_boolean, value_date, value_json)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             on conflict (request_id, field_key) do update
               set value_text = excluded.value_text, value_number = excluded.value_number,
                   value_boolean = excluded.value_boolean, value_date = excluded.value_date,
                   value_json = excluded.value_json`,
            [
              request_.id, field.id, key, field.type,
              typeof value === 'string' ? value : null,
              typeof value === 'number' ? value : null,
              typeof value === 'boolean' ? value : null,
              typeof value === 'string' && field.type === 'DATETIME' ? value : null,
              typeof value === 'object' ? JSON.stringify(value) : null,
            ],
          );
        }
      }

      if (Array.isArray(b.mediaUrls)) {
        for (const url of b.mediaUrls) {
          await c.query(
            `insert into request_media (request_id, uploader_id, kind, url) values ($1,$2,'IMAGE',$3)`,
            [request_.id, auth.userId, url],
          );
        }
      }

      logEvent(LOG_EVENTS.REQUEST_CREATED, { userId: auth.userId, requestId: request_.id, serviceId: service.id });
      return request_;
    });

    return reply.status(201).send({ success: true, data: created });
  });

  // -------- publish ---------------------------------------------------
  app.post('/requests/:id/publish', {
    preHandler: [app.requireCustomer],
    schema: {
      tags: ['requests'], summary: 'Publish a draft request and start matching',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: { expiresInHours: { type: 'integer', minimum: 1, maximum: 720 } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = (request.body ?? {}) as { expiresInHours?: number };

    const updated = await transaction(async (client) => {
      const c = clientQuery(client);
      const req = await c.one<{ id: string; status: string; customer_id: string }>(
        'select id, status, customer_id from requests where id = $1 and deleted_at is null for update',
        [id],
      );
      if (!req) throw notFound('Request');
      if (req.customer_id !== auth.userId) throw forbidden();
      if (req.status !== 'DRAFT') throw businessRule('Only draft requests can be published.');

      // DRAFT -> PUBLISHED is the only legal first step. The middle steps to
      // MATCHING -> RECEIVING_OFFERS are applied below once candidates exist.
      const row = await c.one(
        `update requests set status = 'PUBLISHED', published_at = now(),
               expires_at = now() + ($2 || ' hours')::interval
         where id = $1 returning *`,
        [id, b.expiresInHours ?? 72],
      );

      // Record a match run and the initial candidate set. The matching engine
      // runs synchronously here: once candidates exist the request advances
      // through MATCHING to RECEIVING_OFFERS, which is the state the offer flow
      // and the accept transaction expect. The DB trigger validates each step.
      const run = await c.one<{ id: string }>(
        `insert into match_runs (request_id, algorithm, radius_km, status) values ($1,'v1_geo_score',10,'COMPLETED') returning id`,
        [id],
      );
      let candidateCount = 0;
      if (run) {
        const inserted = await c.query(
          `insert into match_candidates (match_run_id, request_id, provider_id, score, is_eligible)
           select $1, $2, p.id, 0, true
           from providers p
           where p.status = 'ACTIVE' and p.deleted_at is null and p.is_available
             and exists (select 1 from provider_services ps where ps.provider_id = p.id and ps.is_active
                         and ps.service_id = (select service_id from requests where id = $2))`,
          [run.id, id],
        );
        candidateCount = inserted.rowCount ?? 0;
      }

      let result = row;
      if (candidateCount > 0) {
        await c.query(`update requests set status = 'MATCHING' where id = $1`, [id]);
        result = (await c.one(
          `update requests set status = 'RECEIVING_OFFERS', matched_at = now()
           where id = $1 returning *`,
          [id],
        )) ?? row;
      }

      // Notify the matched providers. The candidate rows were just written, so
      // the recipient list is exactly the eligible set — no user sees a
      // request they could not have offered on.
      const matched = await c.many<{ user_id: string }>(
        `select p.user_id from match_candidates mc
         join providers p on p.id = mc.provider_id
         where mc.request_id = $1 and mc.is_eligible`,
        [id],
      );
      const serviceRow = await c.one<{ name_en: string }>(
        `select s.name_en from services s where s.id = (select service_id from requests where id = $1)`,
        [id],
      );
      await enqueue(
        {
          topic: OUTBOX_TOPICS.REQUEST_PUBLISHED,
          aggregateType: 'REQUEST',
          aggregateId: id,
          payload: {
            requestId: id,
            requestCode: result?.code ?? null,
            title: result?.title ?? null,
            status: 'RECEIVING_OFFERS',
            serviceName: serviceRow?.name_en ?? null,
            recipients: [...matched.map((m) => ({ userId: m.user_id, role: 'PROVIDER' })),
                         { userId: auth.userId, role: 'CUSTOMER' }],
            locale: auth.role === 'ADMIN' ? null : null,
          },
        },
        client,
      );

      logEvent(LOG_EVENTS.REQUEST_PUBLISHED, { userId: auth.userId, requestId: id, candidateCount });
      return result;
    });

    return reply.send({ success: true, data: updated });
  });

  // -------- customer's requests ---------------------------------------
  app.get('/requests/mine', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['requests'], summary: 'List my requests', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          status: { type: 'string' },
          sortBy: { type: 'string' }, sortDir: { type: 'string', enum: ['asc', 'desc'] },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);
    const where = ['r.customer_id = $1', 'r.deleted_at is null'];
    const params: unknown[] = [auth.userId];
    if (q.status) {
      params.push(q.status);
      where.push(`r.status = $${params.length}`);
    }
    const orderBy = orderByClause(page, ORDER, 'r.created_at desc');

    const rows = await queryMany(
      `select r.*, s.name_en as service_name, s.slug as service_slug, c.name_en as category_name
       from requests r
       join services s on s.id = r.service_id
       join categories c on c.id = r.category_id
       where ${where.join(' and ')} order by ${orderBy}
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    const total = await queryOne<{ count: string }>(
      `select count(*)::text as count from requests r where ${where.join(' and ')}`, params,
    );
    return reply.send({ success: true, data: buildPage(rows, Number(total?.count ?? 0), page) });
  });

  // -------- open requests feed (providers) ----------------------------
  app.get('/requests/feed', {
    preHandler: [app.requireProvider],
    schema: {
      tags: ['requests'], summary: 'Requests a provider can offer on', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          serviceId: { type: 'string', format: 'uuid' }, cityId: { type: 'string', format: 'uuid' },
          minBudgetMinor: { type: 'integer', minimum: 0 },
          sortBy: { type: 'string' }, sortDir: { type: 'string', enum: ['asc', 'desc'] },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);

    const provider = await queryOne<{ id: string }>('select id from providers where user_id = $1', [auth.userId]);
    if (!provider) throw notFound('Provider profile');

    const where = [
      `r.status in ('PUBLISHED','MATCHING','RECEIVING_OFFERS')`,
      'r.deleted_at is null',
      `(r.expires_at is null or r.expires_at > now())`,
      `exists (select 1 from provider_services ps where ps.provider_id = $1 and ps.is_active and ps.service_id = r.service_id)`,
      `not exists (select 1 from offers o where o.request_id = r.id and o.provider_id = $1 and o.status = 'PENDING')`,
    ];
    const params: unknown[] = [provider.id];

    if (q.serviceId) { params.push(q.serviceId); where.push(`r.service_id = $${params.length}`); }
    if (q.cityId) { params.push(q.cityId); where.push(`r.city_id = $${params.length}`); }
    if (q.minBudgetMinor != null) { params.push(q.minBudgetMinor); where.push(`coalesce(r.budget_max_minor, 0) >= $${params.length}`); }

    const orderBy = orderByClause(page, ORDER, 'r.published_at desc nulls last');
    const rows = await queryMany(
      `select r.id, r.code, r.title, r.description, r.status, r.pricing_model,
              r.budget_min_minor, r.budget_max_minor, r.currency, r.urgency,
              r.pickup_city_name, r.pickup_lat, r.pickup_lng, r.destination_city_name,
              r.scheduled_at, r.offer_count, r.published_at, r.expires_at,
              s.name_en as service_name, s.slug as service_slug, c.name_en as category_name,
              (select count(*) from request_media m where m.request_id = r.id and m.deleted_at is null) as media_count
       from requests r
       join services s on s.id = r.service_id
       join categories c on c.id = r.category_id
       where ${where.join(' and ')} order by ${orderBy}
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    const total = await queryOne<{ count: string }>(
      `select count(*)::text as count from requests r where ${where.join(' and ')}`, params,
    );
    return reply.send({ success: true, data: buildPage(rows, Number(total?.count ?? 0), page) });
  });

  // -------- get one ---------------------------------------------------
  app.get('/requests/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['requests'], summary: 'Get a request with answers and media', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };

    const row = await queryOne<{ customer_id: string; id: string; service_id: string; status: string }>(
      `select r.*, s.name_en as service_name, s.slug as service_slug, s.pricing_model,
              c.name_en as category_name, sc.name_en as subcategory_name
       from requests r
       join services s on s.id = r.service_id
       join categories c on c.id = r.category_id
       left join subcategories sc on sc.id = r.subcategory_id
       where r.id = $1 and r.deleted_at is null`,
      [id],
    );
    if (!row) throw notFound('Request');

    const isOwner = row.customer_id === auth.userId;
    const isAdmin = auth.role === 'ADMIN';

    // Providers may view a published request they are eligible to offer on.
    let providerEligible = false;
    if (!isOwner && !isAdmin && auth.role === 'PROVIDER') {
      const check = await queryOne<{ ok: boolean }>(
        `select exists (
           select 1 from provider_services ps join providers p on p.id = ps.provider_id
           where p.user_id = $1 and ps.service_id = $2 and ps.is_active
         ) as ok`,
        [auth.userId, row.service_id as string],
      );
      providerEligible = Boolean(check?.ok);
      if (providerEligible && !['PUBLISHED', 'MATCHING', 'RECEIVING_OFFERS', 'PROVIDER_SELECTED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED'].includes(row.status as string)) {
        providerEligible = false;
      }
    }

    if (!isOwner && !isAdmin && !providerEligible) throw forbidden();

    const answers = await queryMany('select * from request_answers where request_id = $1', [id]);
    const media = await queryMany('select * from request_media where request_id = $1 and deleted_at is null order by sort_order', [id]);
    const offers = isOwner || isAdmin
      ? await queryMany(
          `select o.id, o.provider_id, o.price_minor, o.currency, o.message, o.eta_minutes,
                  o.status, o.is_counter, o.version, o.expires_at, o.created_at,
                  p.display_name as provider_name, p.avatar_url as provider_avatar, p.rating_avg, p.completed_jobs
           from offers o join providers p on p.id = o.provider_id
           where o.request_id = $1 order by o.created_at desc`,
          [id],
        )
      : [];

    return reply.send({ success: true, data: { request: row, answers, media, offers } });
  });

  // -------- cancel ----------------------------------------------------
  app.post('/requests/:id/cancel', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['requests'], summary: 'Cancel a request', security: [{ bearerAuth: [] }],
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

    const updated = await transaction(async (client) => {
      const c = clientQuery(client);
      const req = await c.one<{ id: string; status: string; customer_id: string }>(
        'select id, status, customer_id from requests where id = $1 and deleted_at is null for update',
        [id],
      );
      if (!req) throw notFound('Request');
      if (req.customer_id !== auth.userId && auth.role !== 'ADMIN') throw forbidden();

      const cancelable = ['DRAFT', 'PUBLISHED', 'MATCHING', 'RECEIVING_OFFERS', 'PROVIDER_SELECTED', 'CONFIRMED', 'IN_PROGRESS'];
      if (!cancelable.includes(req.status)) {
        throw businessRule(`A request in status ${req.status} cannot be cancelled.`);
      }

      const row = await c.one(
        `update requests set status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancellation_reason = $3
         where id = $1 returning *`,
        [id, auth.userId, b.reason ?? null],
      );
      await c.query(`update offers set status = 'REJECTED', rejected_at = now(), rejection_reason = 'request_cancelled'
                     where request_id = $1 and status = 'PENDING'`, [id]);

      // Every provider still holding an offer (or assigned) learns the request
      // was cancelled, along with the customer who did it.
      const parties = await c.many<{ user_id: string; role: string }>(
        `select distinct p.user_id, 'PROVIDER' as role
         from offers o join providers p on p.id = o.provider_id where o.request_id = $1
         union
         select p.user_id, 'PROVIDER' from jobs j join providers p on p.id = j.provider_id where j.request_id = $1`,
        [id],
      );
      await enqueue(
        {
          topic: OUTBOX_TOPICS.REQUEST_CANCELLED,
          aggregateType: 'REQUEST',
          aggregateId: id,
          payload: {
            requestId: id,
            requestCode: row?.code ?? null,
            title: row?.title ?? null,
            status: 'CANCELLED',
            reason: b.reason ?? null,
            recipients: [...parties.map((p) => ({ userId: p.user_id, role: 'PROVIDER' })),
                         { userId: auth.userId, role: 'CUSTOMER' }],
          },
        },
        client,
      );

      logEvent(LOG_EVENTS.REQUEST_CANCELLED, { userId: auth.userId, requestId: id, status: req.status });
      return row;
    });

    return reply.send({ success: true, data: updated });
  });

  // -------- update a draft --------------------------------------------
  app.patch('/requests/:id', {
    preHandler: [app.requireCustomer],
    schema: {
      tags: ['requests'], summary: 'Update a draft request', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string', maxLength: 140 },
          description: { type: 'string', maxLength: 2000 },
          answers: { type: 'object', additionalProperties: true },
          budgetMinMinor: { type: 'integer', minimum: 0 },
          budgetMaxMinor: { type: 'integer', minimum: 0 },
          urgency: { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
          scheduledAt: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const b = request.body as Record<string, unknown>;

    const updated = await transaction(async (client) => {
      const c = clientQuery(client);
      const req = await c.one<{ status: string; customer_id: string }>(
        'select status, customer_id from requests where id = $1 and deleted_at is null for update',
        [id],
      );
      if (!req) throw notFound('Request');
      if (req.customer_id !== auth.userId) throw forbidden();
      if (req.status !== 'DRAFT') throw businessRule('Only draft requests can be edited.');

      return c.one(
        `update requests set
           title = coalesce($2, title),
           description = coalesce($3, description),
           answers = coalesce($4::jsonb, answers),
           budget_min_minor = coalesce($5, budget_min_minor),
           budget_max_minor = coalesce($6, budget_max_minor),
           urgency = coalesce($7, urgency),
           scheduled_at = coalesce($8::timestamptz, scheduled_at)
         where id = $1 returning *`,
        [
          id, b.title ?? null, b.description ?? null,
          b.answers ? JSON.stringify(b.answers) : null,
          b.budgetMinMinor ?? null, b.budgetMaxMinor ?? null,
          b.urgency ?? null, b.scheduledAt ?? null,
        ],
      );
    });

    return reply.send({ success: true, data: updated });
  });
}
