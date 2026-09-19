import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { unauthorized, forbidden, notFound } from '../../core/errors.js';
import { queryOne } from '../../db/pool.js';
import { verifyAccessToken } from '../../core/tokens.js';
import type { AuthService } from '../auth/auth.service.js';
import {
  subscribe,
  unsubscribe,
  conversationRoom,
  requestRoom,
  jobRoom,
  providerRoom,
  subscriberCount,
  type RealtimeEnvelope,
} from '../../core/realtime.js';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger({ component: 'realtime-route' });

export interface RealtimeRouteOptions {
  authService: AuthService;
}

/**
 * GET /realtime — Server-Sent Events stream.
 *
 * SSE is the transport here rather than a socket gateway: it runs on the
 * existing Fastify server and port, reuses the same JWT and session check, and
 * needs no broker. The hub in `core/realtime.ts` owns the room model exactly as
 * doc 14 describes it, so swapping in a socket server later is a transport
 * change, not a rewrite.
 *
 * Auth: `EventSource` cannot set an Authorization header, so the access token
 * is accepted as a query parameter and verified with the same routine the rest
 * of the API uses. An invalid or expired token is rejected before any stream
 * opens.
 */
export async function registerRealtimeRoutes(
  app: FastifyInstance,
  opts: RealtimeRouteOptions,
): Promise<void> {
  app.get('/realtime', {
    schema: {
      tags: ['realtime'],
      summary: 'Open the server-sent events stream for this user',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: {
          token: { type: 'string' },
          conversationId: { type: 'string', format: 'uuid' },
          requestId: { type: 'string', format: 'uuid' },
          jobId: { type: 'string', format: 'uuid' },
        },
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authenticateStream(request, opts.authService);

    const q = request.query as {
      conversationId?: string;
      requestId?: string;
      jobId?: string;
    };

    // Every requested room is verified against the database before the socket
    // is allowed to join it. A client can never join a room by guessing an id.
    const rooms: string[] = [];
    if (q.conversationId) {
      const ok = await queryOne(
        `select 1 from conversations
         where id = $1 and (participant_a = $2 or participant_b = $2)`,
        [q.conversationId, auth.userId],
      );
      if (!ok && auth.role !== 'ADMIN') throw forbidden('You are not a participant in that conversation.');
      rooms.push(conversationRoom(q.conversationId));
    }
    if (q.requestId) {
      const row = await queryOne<{ ok: boolean }>(
        `select (
           r.customer_id = $2
           or exists (select 1 from offers o join providers p on p.id = o.provider_id
                      where o.request_id = r.id and p.user_id = $2)
           or exists (select 1 from jobs j join providers p on p.id = j.provider_id
                      where j.request_id = r.id and p.user_id = $2)
         ) as ok
         from requests r where r.id = $1`,
        [q.requestId, auth.userId],
      );
      if (!row) throw notFound('Request');
      if (!row.ok && auth.role !== 'ADMIN') throw forbidden('You are not a party to that request.');
      rooms.push(requestRoom(q.requestId));
    }
    if (q.jobId) {
      const row = await queryOne<{ ok: boolean }>(
        `select (j.customer_id = $2 or p.user_id = $2) as ok
         from jobs j join providers p on p.id = j.provider_id where j.id = $1`,
        [q.jobId, auth.userId],
      );
      if (!row) throw notFound('Job');
      if (!row.ok && auth.role !== 'ADMIN') throw forbidden('You are not a party to that job.');
      rooms.push(jobRoom(q.jobId));
    }

    if (auth.providerId) {
      rooms.push(providerRoom(auth.providerId));
    }

    // Leave the reply open. Fastify must not try to serialise a body.
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (envelope: RealtimeEnvelope): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`event: ${envelope.event}\n`);
      reply.raw.write(`data: ${JSON.stringify(envelope)}\n\n`);
    };

    // Confirm the stream is live so the client can flip to "connected" without
    // waiting for the first real event.
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ userId: auth.userId, rooms })}\n\n`);

    const subscriberId = subscribe({ userId: auth.userId, rooms, listener: send });

    // Keep intermediaries from closing an idle stream.
    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`: ping\n\n`);
    }, 20_000);
    heartbeat.unref?.();

    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearInterval(heartbeat);
      unsubscribe(subscriberId);
      log.debug({ userId: auth.userId, subscriberId }, 'realtime.stream_closed');
    };

    // `close` fires on client disconnect, tab close, network drop and proxy
    // timeout — one cleanup path covers them all, so no subscriber leaks.
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
    reply.raw.on('close', cleanup);

    // Never resolve early: the handler lives as long as the stream does.
    await new Promise<void>((resolve) => {
      reply.raw.on('close', resolve);
    });
    cleanup();
  });

  app.get('/realtime/status', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['realtime'], summary: 'Realtime hub status', security: [{ bearerAuth: [] }],
    },
  }, async (_request, reply) => {
    return reply.send({
      success: true,
      data: { subscribers: subscriberCount() },
    });
  });
}

interface StreamAuth {
  userId: string;
  role: 'CUSTOMER' | 'PROVIDER' | 'ADMIN';
  providerId: string | null;
}

/**
 * Authenticate the stream. Prefers the normal bearer header (used by tests and
 * any non-browser client) and falls back to the `token` query parameter for
 * `EventSource`. The session row is re-checked so a revoked session cannot
 * hold a stream open.
 */
async function authenticateStream(request: FastifyRequest, authService: AuthService): Promise<StreamAuth> {
  const header = request.headers.authorization;
  const fromHeader = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
  const token = fromHeader ?? (request.query as { token?: string }).token ?? null;
  if (!token) throw unauthorized('A realtime token is required.');

  let payload;
  try {
    payload = await verifyAccessToken(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    throw unauthorized(
      message.includes('expired') ? 'The realtime token has expired.' : 'The realtime token is invalid.',
    );
  }

  const { user } = await authService.resolveSession(payload.sid);
  return {
    userId: user.id,
    role: user.role,
    providerId: user.providerId ?? null,
  };
}
