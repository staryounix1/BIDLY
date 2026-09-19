'use client';

import { useEffect, useRef, useState } from 'react';
import { publicEnv } from './env';
import { api, tokenStore } from './auth-api';

/**
 * Realtime client.
 *
 * Opens one server-sent events stream for the signed-in user and re-emits the
 * events it carries. SSE is the transport the API exposes: it rides the normal
 * HTTP stack, reconnects on its own, and needs no extra broker.
 *
 * Room ids (conversation, request, job) are passed as query parameters and the
 * API verifies membership before joining, so a client can only listen to what
 * it is entitled to. The stream is torn down on unmount and reconnects with a
 * capped backoff if the connection drops.
 */

export type RealtimeEventName =
  | 'notification:new'
  | 'message:new'
  | 'offer:created'
  | 'offer:updated'
  | 'request:updated'
  | 'job:status';

export interface RealtimeEnvelope {
  event: RealtimeEventName | string;
  room?: string;
  data?: Record<string, unknown>;
  at?: string;
}

export interface RealtimeRooms {
  conversationId?: string;
  requestId?: string;
  jobId?: string;
}

export interface RealtimeHandlers {
  onEvent?: (envelope: RealtimeEnvelope) => void;
  onNotification?: (data: Record<string, unknown>) => void;
  onMessage?: (data: Record<string, unknown>) => void;
}

export interface RealtimeState {
  connected: boolean;
  lastEvent: RealtimeEnvelope | null;
}

const BASE_BACKOFF = 1500;
const MAX_BACKOFF = 20_000;

export function useRealtime(rooms: RealtimeRooms, handlers: RealtimeHandlers): RealtimeState {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<RealtimeEnvelope | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const { conversationId, requestId, jobId } = rooms;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const token = tokenStore.access();
    if (!token) return;

    let source: EventSource | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const buildUrl = (): string => {
      const params = new URLSearchParams({ token });
      if (conversationId) params.set('conversationId', conversationId);
      if (requestId) params.set('requestId', requestId);
      if (jobId) params.set('jobId', jobId);
      return `${publicEnv.apiUrl}/api/v1/realtime?${params.toString()}`;
    };

    const dispatch = (name: string, raw: string): void => {
      let envelope: RealtimeEnvelope;
      try {
        envelope = JSON.parse(raw) as RealtimeEnvelope;
      } catch {
        envelope = { event: name, data: { raw } };
      }
      setLastEvent(envelope);
      handlersRef.current.onEvent?.(envelope);
      const data = (envelope.data ?? {}) as Record<string, unknown>;
      if (name === 'notification:new' || envelope.event === 'notification:new') {
        handlersRef.current.onNotification?.(data);
      }
      if (name === 'message:new' || envelope.event === 'message:new') {
        handlersRef.current.onMessage?.(data);
      }
    };

    const NAMES: RealtimeEventName[] = [
      'notification:new', 'message:new', 'offer:created', 'offer:updated', 'request:updated', 'job:status',
    ];

    const connect = (): void => {
      if (stopped) return;
      source = new EventSource(buildUrl());

      source.addEventListener('ready', () => {
        attempt = 0;
        setConnected(true);
      });
      for (const name of NAMES) {
        source.addEventListener(name, (event) => dispatch(name, (event as MessageEvent).data));
      }
      source.addEventListener('message', (event) => dispatch('message', (event as MessageEvent).data));

      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (stopped) return;
        const delay = Math.min(BASE_BACKOFF * 2 ** attempt, MAX_BACKOFF);
        attempt += 1;
        timer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      source?.close();
      source = null;
      setConnected(false);
    };
  }, [conversationId, requestId, jobId]);

  return { connected, lastEvent };
}

/** Fire-and-forget read of the badge count, used on first paint. */
export async function fetchUnreadCount(): Promise<number> {
  const res = await api.get<{ unread: number }>('/notifications/unread-count');
  return res.data.unread;
}
