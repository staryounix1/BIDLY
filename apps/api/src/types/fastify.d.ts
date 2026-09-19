import type { FastifyRequest } from 'fastify';

/**
 * Route metadata.
 *
 * Fastify's base `FastifySchema` only knows validation keywords. These extra
 * fields document each route and can be consumed by an OpenAPI generator or a
 * docs UI; they are inert for request validation.
 */
declare module 'fastify' {
  interface FastifySchema {
    tags?: string[];
    summary?: string;
    description?: string;
    operationId?: string;
    deprecated?: boolean;
    security?: Array<Record<string, unknown>>;
    hide?: boolean;
  }

  interface FastifyRequest {
    /** Populated by the auth plugin on protected routes. */
    auth?: {
      userId: string;
      role: 'CUSTOMER' | 'PROVIDER' | 'ADMIN';
      sessionId: string;
      providerId?: string | null;
      adminRole?: string | null;
      permissions?: string[];
    };
  }
}

export type { FastifyRequest };
