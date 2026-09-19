import type { FastifyInstance } from 'fastify';
import { unauthorized, notFound } from '../../core/errors.js';
import { queryMany, queryOne, transaction, clientQuery } from '../../db/pool.js';
import { buildPage, orderByClause, parsePagination } from '../../core/pagination.js';
import { LOG_EVENTS, logEvent } from '../../core/logger.js';

/**
 * /providers — provider profiles, services, coverage, availability,
 * documents. The full provider dashboard arrives in a later task; this is the
 * underlying, working backend.
 */
export async function registerProviderRoutes(app: FastifyInstance): Promise<void> {
  const ORDER = {
    createdAt: 'created_at',
    rating: 'rating_avg',
    jobs: 'completed_jobs',
    distance: 'distance_km',
  };

  // -------- browse providers (public) --------------------------------
  app.get('/providers', {
    schema: {
      tags: ['providers'],
      summary: 'Browse active providers',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          sortBy: { type: 'string' },
          sortDir: { type: 'string', enum: ['asc', 'desc'] },
          serviceId: { type: 'string', format: 'uuid' },
          cityId: { type: 'string', format: 'uuid' },
          minRating: { type: 'number', minimum: 0, maximum: 5 },
          verifiedOnly: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);
    const where: string[] = [`p.status = 'ACTIVE'`, 'p.deleted_at is null'];
    const params: unknown[] = [];

    if (q.serviceId) {
      params.push(q.serviceId);
      where.push(`exists (select 1 from provider_services ps where ps.provider_id = p.id and ps.service_id = $${params.length} and ps.is_active)`);
    }
    if (q.cityId) {
      params.push(q.cityId);
      where.push(`p.city_id = $${params.length}`);
    }
    if (q.minRating != null) {
      params.push(q.minRating);
      where.push(`p.rating_avg >= $${params.length}`);
    }
    if (q.verifiedOnly) {
      where.push(`p.verification_status = 'VERIFIED'`);
    }

    const orderBy = orderByClause(page, ORDER, 'p.rating_avg desc, p.completed_jobs desc');
    const rows = await queryMany(
      `select p.id, p.display_name, p.avatar_url, p.bio, p.rating_avg, p.rating_count,
              p.completed_jobs, p.verification_status, p.response_rate_bps, p.is_online,
              p.service_radius_km, p.currency, p.city_id
       from providers p
       where ${where.join(' and ')}
       order by ${orderBy}
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    const totalRow = await queryOne<{ count: string }>(
      `select count(*)::text as count from providers p where ${where.join(' and ')}`,
      params,
    );
    return reply.send({ success: true, data: buildPage(rows, Number(totalRow?.count ?? 0), page) });
  });

  app.get('/providers/:id', {
    schema: {
      tags: ['providers'], summary: 'Provider public profile',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const provider = await queryOne(
      `select p.*, c.name_en as city_name, co.name_en as country_name
       from providers p
       left join cities c on c.id = p.city_id
       left join countries co on co.code = p.country_code
       where p.id = $1 and p.deleted_at is null`,
      [id],
    );
    if (!provider) throw notFound('Provider');
    const services = await queryMany(
      `select ps.id, ps.service_id, ps.min_price_minor, ps.max_price_minor, ps.currency,
              ps.eta_minutes, ps.is_active, s.slug, s.name_en, s.name_fr, s.name_ar, s.pricing_model
       from provider_services ps join services s on s.id = ps.service_id
       where ps.provider_id = $1 and ps.is_active`,
      [id],
    );
    const areas = await queryMany(
      `select psa.id, psa.city_id, psa.center_lat, psa.center_lng, psa.radius_km, c.name_en as city_name
       from provider_service_areas psa left join cities c on c.id = psa.city_id
       where psa.provider_id = $1`,
      [id],
    );
    const reviews = await queryMany(
      `select r.id, r.rating, r.comment, r.created_at, p.display_name as author_name
       from reviews r left join user_profiles p on p.user_id = r.author_id
       where r.provider_id = $1 and r.is_visible order by r.created_at desc limit 10`,
      [id],
    );
    return reply.send({ success: true, data: { provider, services, areas, reviews } });
  });

  // -------- become a provider -----------------------------------------
  app.post('/providers', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['providers'],
      summary: 'Create the provider profile for the signed-in user',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['displayName'],
        additionalProperties: false,
        properties: {
          displayName: { type: 'string', minLength: 2, maxLength: 80 },
          legalName: { type: 'string', maxLength: 120 },
          bio: { type: 'string', maxLength: 1000 },
          cityId: { type: 'string', format: 'uuid' },
          serviceRadiusKm: { type: 'number', minimum: 1, maximum: 200 },
          languages: { type: 'array', items: { type: 'string', maxLength: 5 } },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const b = request.body as Record<string, unknown>;

    const existing = await queryOne<{ id: string }>('select id from providers where user_id = $1', [request.auth.userId]);
    if (existing) {
      return reply.status(409).send({
        success: false,
        error: { code: 'ALREADY_EXISTS', message: 'You already have a provider profile.' },
      });
    }

    const created = await transaction(async (client) => {
      const c = clientQuery(client);
      const provider = await c.one<{ id: string }>(
        `insert into providers (user_id, display_name, legal_name, bio, city_id, country_code, service_radius_km, languages, status, currency)
         values ($1,$2,$3,$4,$5,(select code from countries where is_launch_market limit 1),coalesce($6,15),coalesce($7::text[],'{}'),'DRAFT','MAD')
         returning *`,
        [
          request.auth!.userId,
          b.displayName, b.legalName ?? null, b.bio ?? null, b.cityId ?? null,
          b.serviceRadiusKm ?? null, b.languages ?? null,
        ],
      );
      if (!provider) throw notFound('Provider');
      await c.query('update users set role = $2 where id = $1 and role = $3', [request.auth!.userId, 'PROVIDER', 'CUSTOMER']);
      await c.query(
        `insert into wallets (owner_type, owner_id, currency) values ('PROVIDER', $1, 'MAD')
         on conflict (owner_type, owner_id, currency) do nothing`,
        [request.auth!.userId],
      );
      return provider;
    });

    logEvent('provider.created', { userId: request.auth.userId });
    return reply.status(201).send({ success: true, data: created });
  });

  // -------- my provider profile ---------------------------------------
  app.get('/providers/me', {
    preHandler: [app.authenticate],
    schema: { tags: ['providers'], summary: 'Get my provider profile', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const provider = await queryOne('select * from providers where user_id = $1', [request.auth.userId]);
    if (!provider) throw notFound('Provider profile');
    return reply.send({ success: true, data: provider });
  });

  app.patch('/providers/me', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['providers'],
      summary: 'Update my provider profile',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          displayName: { type: 'string', maxLength: 80 },
          bio: { type: 'string', maxLength: 1000 },
          avatarUrl: { type: 'string', maxLength: 2048 },
          serviceRadiusKm: { type: 'number', minimum: 1, maximum: 200 },
          isOnline: { type: 'boolean' },
          isAvailable: { type: 'boolean' },
          languages: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const b = request.body as Record<string, unknown>;
    const updated = await transaction(async (client) =>
      clientQuery(client).one(
        `update providers set
           display_name = coalesce($2, display_name),
           bio = coalesce($3, bio),
           avatar_url = coalesce($4, avatar_url),
           service_radius_km = coalesce($5, service_radius_km),
           is_online = coalesce($6, is_online),
           is_available = coalesce($7, is_available),
           languages = coalesce($8::text[], languages)
         where user_id = $1 returning *`,
        [
          request.auth!.userId, b.displayName ?? null, b.bio ?? null, b.avatarUrl ?? null,
          b.serviceRadiusKm ?? null, b.isOnline ?? null, b.isAvailable ?? null, b.languages ?? null,
        ],
      ),
    );
    if (!updated) throw notFound('Provider profile');
    return reply.send({ success: true, data: updated });
  });

  // -------- provider services -----------------------------------------
  app.get('/providers/me/services', {
    preHandler: [app.authenticate],
    schema: { tags: ['providers'], summary: 'List my offered services', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const rows = await queryMany(
      `select ps.*, s.slug, s.name_en, s.name_fr, s.name_ar, s.pricing_model
       from provider_services ps
       join services s on s.id = ps.service_id
       join providers p on p.id = ps.provider_id
       where p.user_id = $1 order by s.sort_order`,
      [request.auth.userId],
    );
    return reply.send({ success: true, data: rows });
  });

  app.put('/providers/me/services', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['providers'],
      summary: 'Add or update an offered service',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['serviceId'],
        additionalProperties: false,
        properties: {
          serviceId: { type: 'string', format: 'uuid' },
          minPriceMinor: { type: 'integer', minimum: 0 },
          maxPriceMinor: { type: 'integer', minimum: 0 },
          hourlyRateMinor: { type: 'integer', minimum: 0 },
          etaMinutes: { type: 'integer', minimum: 0, maximum: 1440 },
          experienceYears: { type: 'integer', minimum: 0, maximum: 70 },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const b = request.body as Record<string, unknown>;
    const provider = await queryOne<{ id: string; currency: string }>('select id, currency from providers where user_id = $1', [request.auth.userId]);
    if (!provider) throw notFound('Provider profile');

    const row = await transaction(async (client) =>
      clientQuery(client).one(
        `insert into provider_services (provider_id, service_id, min_price_minor, max_price_minor, hourly_rate_minor, eta_minutes, experience_years, currency, is_active)
         values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,true))
         on conflict (provider_id, service_id) do update set
           min_price_minor = coalesce($3, provider_services.min_price_minor),
           max_price_minor = coalesce($4, provider_services.max_price_minor),
           hourly_rate_minor = coalesce($5, provider_services.hourly_rate_minor),
           eta_minutes = coalesce($6, provider_services.eta_minutes),
           experience_years = coalesce($7, provider_services.experience_years),
           is_active = coalesce($9, provider_services.is_active)
         returning *`,
        [
          provider.id, b.serviceId, b.minPriceMinor ?? null, b.maxPriceMinor ?? null,
          b.hourlyRateMinor ?? null, b.etaMinutes ?? null, b.experienceYears ?? null,
          provider.currency, b.isActive ?? null,
        ],
      ),
    );
    return reply.send({ success: true, data: row });
  });

  app.delete('/providers/me/services/:serviceId', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['providers'], summary: 'Stop offering a service', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['serviceId'], properties: { serviceId: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const { serviceId } = request.params as { serviceId: string };
    await transaction(async (client) => {
      await clientQuery(client).query(
        `update provider_services ps set is_active = false
         from providers p
         where ps.provider_id = p.id and p.user_id = $1 and ps.service_id = $2`,
        [request.auth!.userId, serviceId],
      );
    });
    return reply.status(204).send();
  });

  // -------- coverage & availability -----------------------------------
  app.get('/providers/me/areas', {
    preHandler: [app.authenticate],
    schema: { tags: ['providers'], summary: 'List my coverage areas', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const rows = await queryMany(
      `select psa.*, c.name_en as city_name from provider_service_areas psa
       join providers p on p.id = psa.provider_id
       left join cities c on c.id = psa.city_id
       where p.user_id = $1`,
      [request.auth.userId],
    );
    return reply.send({ success: true, data: rows });
  });

  app.post('/providers/me/areas', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['providers'], summary: 'Add a coverage area', security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cityId: { type: 'string', format: 'uuid' },
          serviceAreaId: { type: 'string', format: 'uuid' },
          centerLat: { type: 'number' },
          centerLng: { type: 'number' },
          radiusKm: { type: 'number', minimum: 1, maximum: 200 },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const b = request.body as Record<string, unknown>;
    const provider = await queryOne<{ id: string }>('select id from providers where user_id = $1', [request.auth.userId]);
    if (!provider) throw notFound('Provider profile');
    const row = await transaction(async (client) =>
      clientQuery(client).one(
        `insert into provider_service_areas (provider_id, city_id, service_area_id, center_lat, center_lng, radius_km)
         values ($1,$2,$3,$4,$5,coalesce($6,15)) returning *`,
        [provider.id, b.cityId ?? null, b.serviceAreaId ?? null, b.centerLat ?? null, b.centerLng ?? null, b.radiusKm ?? null],
      ),
    );
    return reply.status(201).send({ success: true, data: row });
  });

  app.get('/providers/me/availability', {
    preHandler: [app.authenticate],
    schema: { tags: ['providers'], summary: 'List my availability', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const rows = await queryMany(
      `select a.* from availability a join providers p on p.id = a.provider_id
       where p.user_id = $1 order by a.weekday nulls last, a.start_time`,
      [request.auth.userId],
    );
    return reply.send({ success: true, data: rows });
  });

  app.put('/providers/me/availability', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['providers'], summary: 'Set a weekly availability slot', security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['weekday', 'startTime', 'endTime'],
        additionalProperties: false,
        properties: {
          weekday: { type: 'integer', minimum: 0, maximum: 6 },
          startTime: { type: 'string', pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' },
          endTime: { type: 'string', pattern: '^\\d{2}:\\d{2}(:\\d{2})?$' },
          period: { type: 'string', enum: ['DAY', 'NIGHT', 'ANY'] },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const b = request.body as Record<string, unknown>;
    const provider = await queryOne<{ id: string }>('select id from providers where user_id = $1', [request.auth.userId]);
    if (!provider) throw notFound('Provider profile');
    const row = await transaction(async (client) =>
      clientQuery(client).one(
        `insert into availability (provider_id, weekday, start_time, end_time, period)
         values ($1,$2,$3::time,$4::time,coalesce($5::bidly_period_type,'ANY'))
         on conflict (provider_id, weekday, start_time, exception_date) do update
           set end_time = excluded.end_time, period = excluded.period
         returning *`,
        [provider.id, b.weekday, b.startTime, b.endTime, b.period ?? null],
      ),
    );
    return reply.send({ success: true, data: row });
  });

  // -------- documents & verification ----------------------------------
  app.get('/providers/me/documents', {
    preHandler: [app.authenticate],
    schema: { tags: ['providers'], summary: 'List my submitted documents', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const rows = await queryMany(
      `select d.id, d.type, d.status, d.file_url, d.rejection_reason, d.expires_at, d.created_at, d.reviewed_at
       from provider_documents d join providers p on p.id = d.provider_id
       where p.user_id = $1 order by d.created_at desc`,
      [request.auth.userId],
    );
    return reply.send({ success: true, data: rows });
  });

  app.post('/providers/me/documents', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['providers'], summary: 'Submit a verification document', security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['type', 'fileUrl'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: ['IDENTITY', 'BUSINESS', 'LICENSE', 'INSURANCE', 'CERTIFICATION'] },
          fileUrl: { type: 'string', minLength: 1, maxLength: 2048 },
          fileMime: { type: 'string', maxLength: 100 },
          documentNumber: { type: 'string', maxLength: 80 },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const b = request.body as Record<string, unknown>;
    const provider = await queryOne<{ id: string }>('select id from providers where user_id = $1', [request.auth.userId]);
    if (!provider) throw notFound('Provider profile');

    const row = await transaction(async (client) => {
      const c = clientQuery(client);
      const doc = await c.one(
        `insert into provider_documents (provider_id, type, file_url, file_mime, document_number, status)
         values ($1,$2,$3,$4,$5,'PENDING') returning *`,
        [provider.id, b.type, b.fileUrl, b.fileMime ?? null, b.documentNumber ?? null],
      );
      await c.query(
        `insert into verification_records (provider_id, type, status, document_id, submitted_at)
         values ($1,$2,'PENDING',(select id from provider_documents where provider_id=$1 and file_url=$3 order by created_at desc limit 1), now())`,
        [provider.id, b.type, b.fileUrl],
      );
      await c.query(
        `update providers set verification_status = 'PENDING'
         where id = $1 and verification_status in ('UNVERIFIED','REJECTED')`,
        [provider.id],
      );
      return doc;
    });
    return reply.status(201).send({ success: true, data: row });
  });
}
