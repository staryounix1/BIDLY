import type { FastifyInstance } from 'fastify';
import { unauthorized, notFound, validationError } from '../../core/errors.js';
import { queryOne, transaction } from '../../db/pool.js';
import { clientQuery } from '../../db/pool.js';

/**
 * /media — the bytes half of request evidence.
 *
 * Photos travel as data URLs inside the request body because they are small
 * after the browser downscales them. A video is not small, and the API parses
 * JSON under a 1 MB cap, so a clip cannot ride in the body at all. These routes
 * take the file itself:
 *
 *   POST /media      raw bytes + Content-Type -> { id, url }
 *   GET  /media/:id  the bytes back, with a long cache header
 *
 * The bytes live in `media_blobs` rather than an object store so that nothing
 * new has to be provisioned; the URL handed back is stable and renderable, so
 * the existing `<img>`/`<video>` viewers need no special case. Moving to real
 * object storage later means writing to a bucket in the POST and storing that
 * URL instead — the clients keep posting the same bytes.
 */

/** A 60 s phone clip is a few tens of MB; anything past this is abuse. */
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

const ALLOWED = /^(image|video)\/[a-z0-9.+-]+$/i;

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Raw binary, not JSON.
   *
   * Fastify has no parser for `image/*` or `video/*` out of the box, so the
   * body would otherwise be rejected before the handler ever sees it. This
   * parser buffers the stream and applies its own size ceiling, which is what
   * lets a large video through while every JSON route keeps its 1 MB cap.
   */
  const binaryParser = (request: unknown, payload: NodeJS.ReadableStream, done: (err: Error | null, body?: Buffer) => void) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    payload.on('data', (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) {
        aborted = true;
        done(validationError({ file: ['The file is too large.'] }));
        return;
      }
      chunks.push(chunk);
    });
    payload.on('end', () => {
      if (!aborted) done(null, Buffer.concat(chunks));
    });
    payload.on('error', (err: Error) => {
      if (!aborted) done(err);
    });
  };

  // Any other `image/*` or `video/*` subtype — a phone may send `video/x-m4v`
  // or `image/jpg` — is claimed by pattern rather than by the finite list
  // above, so an unusual but genuine camera format still uploads. JSON and the
  // application types are deliberately left alone.
  app.addContentTypeParser(/^(image|video)\//, binaryParser);

  app.post('/media', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['media'], summary: 'Upload an image or video and get a URL back',
      security: [{ bearerAuth: [] }],
      consumes: ['image/*', 'video/*', 'application/octet-stream'],
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const body = request.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw validationError({ file: ['A non-empty file is required.'] });
    }

    const rawType = String(request.headers['content-type'] || 'application/octet-stream');
    const mime = (rawType.split(';')[0] ?? '').trim() || 'application/octet-stream';
    if (!ALLOWED.test(mime)) {
      throw validationError({ file: ['Only images and videos can be attached.'] });
    }

    const created = await transaction(async (client) => {
      const c = clientQuery(client);
      const row = await c.one<{ id: string }>(
        `insert into media_blobs (uploader_id, mime_type, size_bytes, bytes)
         values ($1,$2,$3,$4) returning id`,
        [request.auth!.userId, mime, body.length, body],
      );
      if (!row) throw validationError({ file: ['The upload could not be stored.'] });
      return row;
    });

    // Relative on purpose: the web app proxies /api to this service, so an
    // absolute URL built from the request host would break behind the tunnel.
    return reply.status(201).send({
      success: true,
      data: { id: created.id, url: `/api/v1/media/${created.id}`, mimeType: mime, sizeBytes: body.length },
    });
  });

  app.get('/media/:id', {
    schema: {
      tags: ['media'], summary: 'Fetch an uploaded file',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = await queryOne<{ mime_type: string; bytes: Buffer; size_bytes: string }>(
      `select mime_type, bytes, size_bytes from media_blobs where id = $1`,
      [id],
    );
    if (!row) throw notFound('File');

    return reply
      .header('Content-Type', row.mime_type)
      .header('Content-Length', String(row.size_bytes))
      // Content never changes for a given id, so this can be cached hard.
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(row.bytes);
  });
}
