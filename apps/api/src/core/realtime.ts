import { randomUUID } from 'node:crypto';
import { createChildLogger } from './logger.js';

const log = createChildLogger({ component: 'realtime' });

/**
 * In-process realtime hub.
 *
 * Implements the room model from doc 14 (§14.3): every subscriber is bound to
 * a user and may belong to several rooms (`user:{id}`, `conversation:{id}`,
 * `request:{id}`, `job:{id}`, `provider:{id}`). Delivery is deliberately
 * in-process and transport-agnostic: the SSE route is one consumer, and the
 * outbox worker is the only producer. That keeps a single source of truth for
 * who may receive what, and makes the hub testable without a network.
 *
 * Scaling note: a multi-instance deployment would back `publish` with the
 * documented Redis adapter. Everything above this module already speaks in
 * rooms and events, so only this file changes.
 */

export type RealtimeEvent =
  | 'notification:new'
  | 'request:matched'
  | 'request:updated'
  | 'offer:created'
  | 'offer:updated'
  | 'offer:expiring'
  | 'negotiation:event'
  | 'job:status'
  | 'message:new'
  | 'message:read'
  | 'ping';

export interface RealtimeEnvelope {
  event: RealtimeEvent;
  room: string;
  data: unknown;
  at: string;
}

export type RealtimeListener = (envelope: RealtimeEnvelope) => void;

interface Subscriber {
  id: string;
  userId: string;
  rooms: Set<string>;
  listener: RealtimeListener;
  connectedAt: number;
}

/** The rooms a given user is always entitled to. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}
export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}
export function requestRoom(requestId: string): string {
  return `request:${requestId}`;
}
export function jobRoom(jobId: string): string {
  return `job:${jobId}`;
}
export function providerRoom(providerId: string): string {
  return `provider:${providerId}`;
}

const subscribers = new Map<string, Subscriber>();

export interface SubscribeOptions {
  userId: string;
  rooms?: string[];
  listener: RealtimeListener;
}

/**
 * Register a subscriber. Always joins the user's own room; extra rooms must be
 * authorised by the caller before they are passed in (the hub cannot check the
 * database, so it is the route's job — see realtime.routes.ts).
 */
export function subscribe(options: SubscribeOptions): string {
  const id = randomUUID();
  const rooms = new Set<string>([userRoom(options.userId), ...(options.rooms ?? [])]);
  subscribers.set(id, {
    id,
    userId: options.userId,
    rooms,
    listener: options.listener,
    connectedAt: Date.now(),
  });
  log.debug({ subscriberId: id, userId: options.userId, rooms: [...rooms] }, 'realtime.subscribe');
  return id;
}

/** Remove a subscriber. Safe to call twice; this is the cleanup path. */
export function unsubscribe(id: string): void {
  if (subscribers.delete(id)) {
    log.debug({ subscriberId: id }, 'realtime.unsubscribe');
  }
}

export function subscriberCount(): number {
  return subscribers.size;
}

export function roomCount(room: string): number {
  let n = 0;
  for (const s of subscribers.values()) if (s.rooms.has(room)) n++;
  return n;
}

/** Add a subscriber to a room it is already authorised for. */
export function joinRoom(id: string, room: string): void {
  subscribers.get(id)?.rooms.add(room);
}

export function leaveRoom(id: string, room: string): void {
  subscribers.get(id)?.rooms.delete(room);
}

/**
 * Deliver an event to everyone in a room.
 *
 * A listener that throws is isolated: one broken connection never stops
 * delivery to the others, and the failure is logged rather than rethrown into
 * the publishing request path.
 */
export function publish(room: string, event: RealtimeEvent, data: unknown, at = new Date()): number {
  const envelope: RealtimeEnvelope = { event, room, data, at: toDate(at).toISOString() };
  let delivered = 0;
  for (const s of subscribers.values()) {
    if (!s.rooms.has(room)) continue;
    try {
      s.listener(envelope);
      delivered++;
    } catch (err) {
      log.warn(
        { subscriberId: s.id, room, event, err: err instanceof Error ? err.message : String(err) },
        'realtime.listener_error',
      );
    }
  }
  return delivered;
}

/** Publish to several rooms at once (used for a request + each party's room). */
export function publishMany(rooms: string[], event: RealtimeEvent, data: unknown): number {
  let total = 0;
  for (const room of new Set(rooms)) total += publish(room, event, data);
  return total;
}

/** Deliver to a specific user regardless of their other room memberships. */
export function publishToUser(userId: string, event: RealtimeEvent, data: unknown): number {
  return publish(userRoom(userId), event, data);
}

/** Only used by tests to guarantee a clean slate between cases. */
export function resetHub(): void {
  subscribers.clear();
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
