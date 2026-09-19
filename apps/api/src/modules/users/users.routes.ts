import type { FastifyInstance } from 'fastify';
import { unauthorized } from '../../core/errors.js';
import { queryOne, transaction } from '../../db/pool.js';
import { clientQuery } from '../../db/pool.js';

/**
 * /users — profile, addresses, preferences, devices, public profiles.
 * Advanced social/admin features arrive in later tasks.
 */
export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  // -------- my profile -----------------------------------------------
  app.get('/users/me/profile', {
    preHandler: [app.authenticate],
    schema: { tags: ['users'], summary: 'Get my profile', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const profile = await queryOne(
      `select p.*, u.email, u.phone, u.role, u.status, u.locale, u.country_code,
              u.email_verified_at, u.phone_verified_at
       from user_profiles p join users u on u.id = p.user_id
       where p.user_id = $1`,
      [request.auth.userId],
    );
    return reply.send({ success: true, data: profile });
  });

  app.patch('/users/me/profile', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['users'],
      summary: 'Update my profile',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fullName: { type: 'string', maxLength: 120 },
          displayName: { type: 'string', maxLength: 60 },
          bio: { type: 'string', maxLength: 500 },
          avatarUrl: { type: 'string', maxLength: 2048 },
          preferredLocale: { type: 'string', enum: ['ar', 'fr', 'en'] },
          preferredCurrency: { type: 'string', minLength: 3, maxLength: 3 },
          dateOfBirth: { type: 'string' },
          gender: { type: 'string', maxLength: 20 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const b = request.body as Record<string, string | undefined>;
    const updated = await transaction(async (client) => {
      const c = clientQuery(client);
      return c.one(
        `update user_profiles set
           full_name = coalesce($2, full_name),
           display_name = coalesce($3, display_name),
           bio = coalesce($4, bio),
           avatar_url = coalesce($5, avatar_url),
           preferred_locale = coalesce($6, preferred_locale),
           preferred_currency = coalesce($7, preferred_currency),
           date_of_birth = coalesce($8::date, date_of_birth),
           gender = coalesce($9, gender)
         where user_id = $1
         returning *`,
        [
          auth.userId,
          b.fullName ?? null,
          b.displayName ?? null,
          b.bio ?? null,
          b.avatarUrl ?? null,
          b.preferredLocale ?? null,
          b.preferredCurrency ?? null,
          b.dateOfBirth ?? null,
          b.gender ?? null,
        ],
      );
    });
    return reply.send({ success: true, data: updated });
  });

  // -------- addresses -------------------------------------------------
  app.get('/users/me/addresses', {
    preHandler: [app.authenticate],
    schema: { tags: ['users'], summary: 'List my saved addresses', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const rows = await import('../../db/pool.js').then((m) =>
      m.queryMany('select * from user_addresses where user_id = $1 and deleted_at is null order by is_default desc, created_at desc', [
        request.auth!.userId,
      ]),
    );
    return reply.send({ success: true, data: rows });
  });

  app.post('/users/me/addresses', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['users'],
      summary: 'Create a saved address',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['line1'],
        additionalProperties: false,
        properties: {
          label: { type: 'string', maxLength: 40 },
          line1: { type: 'string', minLength: 3, maxLength: 200 },
          line2: { type: 'string', maxLength: 200 },
          district: { type: 'string', maxLength: 100 },
          cityId: { type: 'string', format: 'uuid' },
          cityName: { type: 'string', maxLength: 100 },
          lat: { type: 'number', minimum: -90, maximum: 90 },
          lng: { type: 'number', minimum: -180, maximum: 180 },
          isDefault: { type: 'boolean' },
          notes: { type: 'string', maxLength: 300 },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const b = request.body as Record<string, unknown>;
    const created = await transaction(async (client) => {
      const c = clientQuery(client);
      if (b.isDefault) {
        await c.query('update user_addresses set is_default = false where user_id = $1', [request.auth!.userId]);
      }
      return c.one(
        `insert into user_addresses (user_id, label, line1, line2, district, city_id, city_name, lat, lng, notes, is_default)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11,false))
         returning *`,
        [
          request.auth!.userId,
          b.label ?? null, b.line1, b.line2 ?? null, b.district ?? null,
          b.cityId ?? null, b.cityName ?? null, b.lat ?? null, b.lng ?? null,
          b.notes ?? null, b.isDefault ?? false,
        ],
      );
    });
    return reply.status(201).send({ success: true, data: created });
  });

  app.delete('/users/me/addresses/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['users'], summary: 'Soft-delete a saved address', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const { id } = request.params as { id: string };
    await transaction(async (client) => {
      await clientQuery(client).query(
        'update user_addresses set deleted_at = now() where id = $1 and user_id = $2',
        [id, request.auth!.userId],
      );
    });
    return reply.status(204).send();
  });

  // -------- notification preferences ---------------------------------
  app.get('/users/me/notification-preferences', {
    preHandler: [app.authenticate],
    schema: { tags: ['users'], summary: 'Get notification preferences', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const rows = await import('../../db/pool.js').then((m) =>
      m.queryMany('select * from notification_preferences where user_id = $1', [request.auth!.userId]),
    );
    return reply.send({ success: true, data: rows });
  });

  app.put('/users/me/notification-preferences', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['users'], summary: 'Upsert a notification preference', security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['eventType'],
        additionalProperties: false,
        properties: {
          eventType: { type: 'string', maxLength: 80 },
          inApp: { type: 'boolean' },
          push: { type: 'boolean' },
          email: { type: 'boolean' },
          sms: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const b = request.body as Record<string, unknown>;
    const row = await transaction(async (client) =>
      clientQuery(client).one(
        `insert into notification_preferences (user_id, event_type, in_app, push, email, sms)
         values ($1,$2,coalesce($3,true),coalesce($4,true),coalesce($5,true),coalesce($6,false))
         on conflict (user_id, event_type) do update
           set in_app = coalesce($3, notification_preferences.in_app),
               push = coalesce($4, notification_preferences.push),
               email = coalesce($5, notification_preferences.email),
               sms = coalesce($6, notification_preferences.sms)
         returning *`,
        [request.auth!.userId, b.eventType, b.inApp ?? null, b.push ?? null, b.email ?? null, b.sms ?? null],
      ),
    );
    return reply.send({ success: true, data: row });
  });

  // -------- devices ---------------------------------------------------
  app.post('/users/me/devices', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['users'], summary: 'Register a device for push notifications', security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['pushToken'],
        additionalProperties: false,
        properties: {
          pushToken: { type: 'string', maxLength: 500 },
          platform: { type: 'string', enum: ['IOS', 'ANDROID', 'WEB'] },
          deviceId: { type: 'string', maxLength: 128 },
          appVersion: { type: 'string', maxLength: 40 },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const b = request.body as Record<string, unknown>;
    const row = await transaction(async (client) =>
      clientQuery(client).one(
        `insert into devices (user_id, platform, push_token, device_id, app_version, last_seen_at)
         values ($1, coalesce($2,'WEB'), $3, $4, $5, now())
         on conflict (user_id, platform, push_token) do update set last_seen_at = now(), is_active = true
         returning *`,
        [request.auth!.userId, b.platform ?? null, b.pushToken, b.deviceId ?? null, b.appVersion ?? null],
      ),
    );
    return reply.status(201).send({ success: true, data: row });
  });

  // -------- public profile --------------------------------------------
  app.get('/users/:id/public', {
    schema: {
      tags: ['users'], summary: 'Public profile of a user (display data only)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await queryOne(
      `select u.id, p.display_name, p.avatar_url, p.bio, p.created_at,
              pr.id as provider_id, pr.display_name as provider_name,
              pr.rating_avg, pr.rating_count, pr.completed_jobs, pr.verification_status
       from users u
       left join user_profiles p on p.user_id = u.id
       left join providers pr on pr.user_id = u.id and pr.status = 'ACTIVE' and pr.deleted_at is null
       where u.id = $1 and u.deleted_at is null and u.status = 'ACTIVE'`,
      [id],
    );
    return reply.send({ success: true, data: row });
  });
}
