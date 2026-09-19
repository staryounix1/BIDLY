import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { env } from '@bidly/config';
import { AuthService, type Notifier } from './modules/auth/auth.service.js';
import { registerAuthRoutes } from './modules/auth/auth.routes.js';
import { registerUserRoutes } from './modules/users/users.routes.js';
import { registerProviderRoutes } from './modules/providers/providers.routes.js';
import { registerCatalogRoutes } from './modules/catalog/catalog.routes.js';
import { registerRequestRoutes } from './modules/requests/requests.routes.js';
import { registerOfferRoutes } from './modules/offers/offers.routes.js';
import { registerJobRoutes } from './modules/jobs/jobs.routes.js';
import { registerMessageRoutes } from './modules/messages/messages.routes.js';
import { registerPaymentRoutes } from './modules/payments/payments.routes.js';
import { registerReviewRoutes } from './modules/reviews/reviews.routes.js';
import { registerDisputeRoutes } from './modules/disputes/disputes.routes.js';
import { registerNotificationRoutes } from './modules/notifications/notifications.routes.js';
import { registerRealtimeRoutes } from './modules/realtime/realtime.routes.js';
import { registerAdminRoutes } from './modules/admin/admin.routes.js';
import { registerSupportRoutes, registerSupportPublicRoutes } from './modules/support/support.routes.js';
import { authPlugin } from './plugins/auth.plugin.js';
import { errorHandler } from './core/error-handler.js';
import { createNotificationAdapters, type NotificationAdapters } from './core/providers.js';
import { healthCheck } from './db/pool.js';
import { initLogger, LOG_EVENTS, logEvent } from './core/logger.js';

export interface AppDependencies {
  authService: AuthService;
  notifier: Notifier;
  adapters: NotificationAdapters;
}

/** Build the configured Fastify instance without starting it (testable). */
export async function buildApp(
  overrides?: Partial<AppDependencies>,
  opts?: FastifyServerOptions,
): Promise<FastifyInstance> {
  initLogger({ level: env.LOG_LEVEL, pretty: env.LOG_PRETTY && env.NODE_ENV !== 'production' });

  const adapters = overrides?.adapters ?? createNotificationAdapters();

  const notifier: Notifier =
    overrides?.notifier ?? {
      sendEmail: (to, subject, body) => adapters.email.send(to, subject, body),
      sendSms: (to, body) => adapters.sms.send(to, body),
    };

  const authService = overrides?.authService ?? new AuthService(notifier);

  const app = Fastify({
    logger: false,
    trustProxy: true,
    genReqId: () => randomUUID(),
    bodyLimit: 2 * 1024 * 1024,
    ...opts,
  });

  // --- cross-cutting plugins -----------------------------------------
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });

  await app.register(cors, {
    origin: (origin, cb) => {
      const allowed = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
      if (!origin || allowed.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
  });

  await app.register(sensible);

  // Payment webhooks must be verified against the exact bytes the provider
  // signed, so that one route needs the raw body rather than parsed JSON.
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1 * 1024 * 1024 }, (request, body, done) => {
    if (typeof request.url === 'string' && request.url.includes('/payments/webhook')) {
      done(null, body);
      return;
    }
    try {
      done(null, JSON.parse(body.toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  await app.register(rateLimit, {
    global: env.RATE_LIMIT_ENABLED,
    max: env.RATE_LIMIT_API_PER_WINDOW,
    timeWindow: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
    allowList: [],
    keyGenerator: (request) => {
      const authHeader = request.headers.authorization;
      if (authHeader) return `token:${authHeader.slice(-24)}`;
      return `ip:${request.ip}`;
    },
  });

  await app.register(authPlugin, { authService });

  // --- request context -----------------------------------------------
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    const durationMs = Math.round(reply.elapsedTime);
    if (reply.statusCode >= 500) {
      logEvent(LOG_EVENTS.REQUEST_ERROR, {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions?.url ?? request.url,
        statusCode: reply.statusCode,
        durationMs,
      });
    }
  });

  app.setErrorHandler(errorHandler as never);
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      success: false,
      error: { code: 'NOT_FOUND', message: 'The requested endpoint was not found.', requestId: request.id },
    });
  });

  // --- health & meta --------------------------------------------------
  app.get('/health', {
    schema: { tags: ['system'], summary: 'Liveness probe' },
  }, async () => ({
    success: true,
    data: {
      status: 'ok',
      service: 'bidly-api',
      version: '0.1.0',
      environment: env.NODE_ENV,
      time: new Date().toISOString(),
    },
  }));

  app.get('/health/ready', {
    schema: { tags: ['system'], summary: 'Readiness probe (checks the database)' },
  }, async (_request, reply) => {
    const db = await healthCheck();
    const ready = db.ok;
    return reply.status(ready ? 200 : 503).send({
      success: ready,
      data: {
        status: ready ? 'ready' : 'degraded',
        checks: { database: db },
      },
    });
  });

  app.get('/meta', {
    schema: { tags: ['system'], summary: 'Public platform metadata (market configuration)' },
  }, async () => ({
    success: true,
    data: {
      name: env.APP_NAME,
      defaultCountry: env.DEFAULT_COUNTRY,
      defaultCurrency: env.DEFAULT_CURRENCY,
      defaultLocale: env.DEFAULT_LOCALE,
      supportedLocales: env.SUPPORTED_LOCALES.split(','),
      timezone: env.DEFAULT_TIMEZONE,
      demoMode: env.DEMO_MODE,
    },
  }));

  // --- feature modules ------------------------------------------------
  await app.register(
    async (api) => {
      await api.register(registerAuthRoutes, { authService, notifier });
      await api.register(registerUserRoutes);
      await api.register(registerProviderRoutes);
      await api.register(registerCatalogRoutes);
      await api.register(registerRequestRoutes);
      await api.register(registerOfferRoutes);
      await api.register(registerJobRoutes);
      await api.register(registerMessageRoutes);
      await api.register(registerPaymentRoutes);
      await api.register(registerReviewRoutes);
      await api.register(registerDisputeRoutes);
      await api.register(registerNotificationRoutes);
      await api.register(registerRealtimeRoutes, { authService });
      await api.register(registerAdminRoutes);
      await api.register(registerSupportRoutes);
      await api.register(registerSupportPublicRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
