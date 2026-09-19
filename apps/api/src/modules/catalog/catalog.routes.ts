import type { FastifyInstance } from 'fastify';
import { notFound } from '../../core/errors.js';
import { queryMany, queryOne } from '../../db/pool.js';

/**
 * /categories, /services — the config-driven catalog.
 *
 * The frontend renders dynamic forms from these payloads; there is no
 * per-service form component anywhere in the product.
 */
export async function registerCatalogRoutes(app: FastifyInstance): Promise<void> {
  const LOCALE_COLUMNS = ['name_en', 'name_fr', 'name_ar'] as const;

  // -------- full catalog tree ----------------------------------------
  app.get('/categories', {
    schema: {
      tags: ['catalog'],
      summary: 'Full category -> subcategory -> service tree with dynamic field definitions',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          withFields: { type: 'boolean' },
          cityId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request, reply) => {
    const q = request.query as { withFields?: boolean; cityId?: string };

    const categories = await queryMany(
      `select id, slug, name_en, name_fr, name_ar, description_en, description_fr, description_ar,
              icon, color, sort_order
       from categories where is_active order by sort_order, name_en`,
    );
    const subcategories = await queryMany(
      `select id, category_id, slug, name_en, name_fr, name_ar, icon, sort_order
       from subcategories where is_active order by sort_order, name_en`,
    );
    const services = await queryMany(
      `select id, subcategory_id, slug, name_en, name_fr, name_ar,
              pricing_model, default_currency, min_price_minor, max_price_minor,
              requires_location, requires_destination, requires_schedule, duration_minutes, sort_order
       from services where is_active order by sort_order, name_en`,
    );

    let fields: unknown[] = [];
    if (q.withFields) {
      fields = await queryMany(
        `select id, service_id, key, label_en, label_fr, label_ar,
                placeholder_en, placeholder_fr, placeholder_ar,
                help_en, help_fr, help_ar,
                type, is_required, sort_order, min_value, max_value, min_length, max_length,
                regex, default_value, depends_on_key, depends_on_value, validation
         from service_fields where is_active order by sort_order`,
      );
    }

    const tree = categories.map((cat) => ({
      ...cat,
      subcategories: subcategories
        .filter((sub) => sub.category_id === cat.id)
        .map((sub) => ({
          ...sub,
          services: services.filter((s) => s.subcategory_id === sub.id),
        })),
    }));

    return reply.send({
      success: true,
      data: {
        categories: tree,
        fields: q.withFields ? fields : undefined,
        locales: LOCALE_COLUMNS,
      },
    });
  });

  app.get('/categories/:slug', {
    schema: {
      tags: ['catalog'],
      summary: 'One category with its subcategories and services',
      params: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const category = await queryOne('select * from categories where slug = $1 and is_active', [slug]);
    if (!category) throw notFound('Category');
    const subcategories = await queryMany(
      'select * from subcategories where category_id = $1 and is_active order by sort_order',
      [category.id as string],
    );
    const services = await queryMany(
      `select s.* from services s
       join subcategories sc on sc.id = s.subcategory_id
       where sc.category_id = $1 and s.is_active order by s.sort_order`,
      [category.id as string],
    );
    return reply.send({ success: true, data: { category, subcategories, services } });
  });

  // -------- services ---------------------------------------------------
  app.get('/services', {
    schema: {
      tags: ['catalog'],
      summary: 'List services',
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          subcategoryId: { type: 'string', format: 'uuid' },
          categoryId: { type: 'string', format: 'uuid' },
          search: { type: 'string', maxLength: 80 },
        },
      },
    },
  }, async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const where: string[] = ['s.is_active'];
    const params: unknown[] = [];

    if (q.subcategoryId) {
      params.push(q.subcategoryId);
      where.push(`s.subcategory_id = $${params.length}`);
    }
    if (q.categoryId) {
      params.push(q.categoryId);
      where.push(`s.subcategory_id in (select id from subcategories where category_id = $${params.length})`);
    }
    if (q.search) {
      params.push(`%${q.search}%`);
      where.push(`(s.name_en ilike $${params.length} or s.name_fr ilike $${params.length} or s.name_ar ilike $${params.length})`);
    }

    const rows = await queryMany(
      `select s.*, sc.slug as subcategory_slug, c.slug as category_slug
       from services s
       join subcategories sc on sc.id = s.subcategory_id
       join categories c on c.id = sc.category_id
       where ${where.join(' and ')}
       order by c.sort_order, sc.sort_order, s.sort_order`,
      params,
    );
    return reply.send({ success: true, data: rows });
  });

  app.get('/services/:slug/form', {
    schema: {
      tags: ['catalog'],
      summary: 'Dynamic form definition (fields + options) for a service',
      params: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const service = await queryOne(
      `select s.*, sc.slug as subcategory_slug, sc.name_en as subcategory_name, c.slug as category_slug, c.name_en as category_name
       from services s
       join subcategories sc on sc.id = s.subcategory_id
       join categories c on c.id = sc.category_id
       where s.slug = $1 and s.is_active`,
      [slug],
    );
    if (!service) throw notFound('Service');

    const fields = await queryMany(
      `select * from service_fields where service_id = $1 and is_active order by sort_order`,
      [service.id as string],
    );
    const fieldIds = fields.map((f) => f.id as string);
    const options = fieldIds.length
      ? await queryMany(
          `select * from service_field_options where field_id = any($1::uuid[]) and is_active order by sort_order`,
          [fieldIds],
        )
      : [];

    const form = fields.map((f) => ({
      ...f,
      options: options.filter((o) => o.field_id === f.id),
    }));

    return reply.send({
      success: true,
      data: { service, fields: form },
    });
  });

  // -------- locations --------------------------------------------------
  app.get('/countries', {
    schema: { tags: ['catalog'], summary: 'Active countries and market config' },
  }, async (_request, reply) => {
    const rows = await queryMany('select * from countries where is_active order by is_launch_market desc, name_en');
    return reply.send({ success: true, data: rows });
  });

  app.get('/cities', {
    schema: {
      tags: ['catalog'], summary: 'Active cities',
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { countryCode: { type: 'string', minLength: 2, maxLength: 2 } },
      },
    },
  }, async (request, reply) => {
    const { countryCode } = request.query as { countryCode?: string };
    const rows = countryCode
      ? await queryMany('select * from cities where is_active and country_code = $1 order by is_launch desc, name_en', [countryCode])
      : await queryMany('select * from cities where is_active order by is_launch desc, name_en');
    return reply.send({ success: true, data: rows });
  });

  app.get('/currencies', {
    schema: { tags: ['catalog'], summary: 'Active currencies' },
  }, async (_request, reply) => {
    const rows = await queryMany('select * from currencies where is_active order by code');
    return reply.send({ success: true, data: rows });
  });

  // -------- public settings -------------------------------------------
  app.get('/settings/public', {
    schema: { tags: ['catalog'], summary: 'Public platform settings' },
  }, async (_request, reply) => {
    const rows = await queryMany('select key, value, value_type from settings where is_public order by key');
    const map: Record<string, unknown> = {};
    for (const row of rows) map[row.key as string] = row.value;
    return reply.send({ success: true, data: map });
  });
}
