import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError, ERROR_CODES } from '../core/errors.js';
import { verifyAccessToken } from '../core/tokens.js';
import type { AuthContext } from '../core/rbac.js';
import { assertAdminPermission, type AdminPermission } from '../core/rbac.js';
import type { AuthService } from '../modules/auth/auth.service.js';
import { createChildLogger } from '../core/logger.js';

export interface AuthPluginOptions {
  authService: AuthService;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    optionalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (...roles: Array<'CUSTOMER' | 'PROVIDER' | 'ADMIN'>) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCustomer: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireProvider: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (permission: AdminPermission | AdminPermission[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const log = createChildLogger({ component: 'auth-plugin' });

function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') return null;
  return token;
}

/**
 * Authentication plugin.
 *
 * Verifies the access token cryptographically AND re-checks the session row,
 * so a revoked session stops working immediately rather than at token expiry.
 * The role always comes from the verified token + database, never from the
 * request body or a client-supplied header.
 */
export const authPlugin = fp<AuthPluginOptions>(async (app: FastifyInstance, opts: AuthPluginOptions) => {
  app.decorateRequest('auth', undefined);

  app.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = extractBearer(request);
    if (!token) throw new AppError({ code: ERROR_CODES.UNAUTHENTICATED });

    let payload;
    try {
      payload = await verifyAccessToken(token);
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      throw new AppError({
        code: message.includes('expired') ? ERROR_CODES.TOKEN_EXPIRED : ERROR_CODES.TOKEN_INVALID,
      });
    }

    // Session liveness check (revocation wins over token validity).
    try {
      const { user } = await opts.authService.resolveSession(payload.sid);
      const authz = await opts.authService.loadAuthorization(user);
      request.auth = {
        userId: user.id,
        role: user.role,
        sessionId: payload.sid,
        providerId: user.providerId ?? null,
        adminRole: authz.adminRole,
        permissions: authz.permissions,
      };
    } catch (err) {
      log.warn({ sid: payload.sid, err: err instanceof Error ? err.message : err }, 'auth.session_rejected');
      throw new AppError({ code: ERROR_CODES.TOKEN_INVALID });
    }
  });

  app.decorate('optionalAuth', async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = extractBearer(request);
    if (!token) return;
    try {
      const payload = await verifyAccessToken(token);
      const { user } = await opts.authService.resolveSession(payload.sid);
      const authz = await opts.authService.loadAuthorization(user);
      request.auth = {
        userId: user.id,
        role: user.role,
        sessionId: payload.sid,
        providerId: user.providerId ?? null,
        adminRole: authz.adminRole,
        permissions: authz.permissions,
      };
    } catch {
      // Optional: invalid tokens are simply treated as anonymous.
    }
  });

  app.decorate('requireRole', (...roles: Array<'CUSTOMER' | 'PROVIDER' | 'ADMIN'>) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      await app.authenticate(request, reply);
      if (!request.auth || !roles.includes(request.auth.role)) {
        throw new AppError({ code: ERROR_CODES.FORBIDDEN });
      }
    };
  });

  app.decorate('requireCustomer', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (request.auth?.role !== 'CUSTOMER') throw new AppError({ code: ERROR_CODES.FORBIDDEN });
  });

  app.decorate('requireProvider', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (request.auth?.role !== 'PROVIDER') throw new AppError({ code: ERROR_CODES.FORBIDDEN });
  });

  app.decorate('requireAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(request, reply);
    if (!request.auth || request.auth.role !== 'ADMIN') throw new AppError({ code: ERROR_CODES.FORBIDDEN });
  });

  /**
   * Require a specific admin permission. An ADMIN without the needed grant is
   * rejected with INSUFFICIENT_PERMISSIONS; a non-admin with FORBIDDEN.
   */
  app.decorate('requirePermission', (permission: AdminPermission | AdminPermission[]) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      await app.authenticate(request, reply);
      if (!request.auth) throw new AppError({ code: ERROR_CODES.FORBIDDEN });
      assertAdminPermission(request.auth, permission);
    };
  });
});
