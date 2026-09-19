import { describe, expect, it } from 'vitest';
import { notificationHref, notificationText, type AppNotification } from './notifications-api';

function note(partial: Partial<AppNotification>): AppNotification {
  return {
    id: 'n1', type: 'MESSAGE_NEW',
    title_en: 'New message', title_fr: 'Nouveau message', title_ar: 'رسالة جديدة',
    body_en: 'Hello', body_fr: 'Bonjour', body_ar: 'مرحبا',
    data: null, channel: 'IN_APP', is_read: false, read_at: null,
    reference_type: null, reference_id: null, created_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

describe('notificationText', () => {
  it('picks the column for the active locale', () => {
    const n = note({});
    expect(notificationText(n, 'ar').title).toBe('رسالة جديدة');
    expect(notificationText(n, 'fr').body).toBe('Bonjour');
    expect(notificationText(n, 'en').title).toBe('New message');
  });

  it('falls back to English for an unknown locale', () => {
    expect(notificationText(note({}), 'de').title).toBe('New message');
  });

  it('falls back to the type when the title is missing', () => {
    expect(notificationText(note({ title_en: '' }), 'en').title).toBe('MESSAGE_NEW');
  });
});

describe('notificationHref', () => {
  it('routes requests to the request detail', () => {
    expect(notificationHref(note({ reference_type: 'REQUEST', reference_id: 'r1' }), 'ar')).toBe('/ar/requests/r1');
  });

  it('routes job status changes to the job detail', () => {
    expect(notificationHref(note({ type: 'JOB_STATUS_CHANGED', reference_type: 'JOB', reference_id: 'j1' }), 'fr')).toBe('/fr/jobs/j1');
  });

  it('routes messages to the conversation from the event data', () => {
    const n = note({ reference_type: 'MESSAGE', data: { conversationId: 'c9' } });
    expect(notificationHref(n, 'en')).toBe('/en/messages/c9');
  });

  it('falls back to the inbox when a message has no conversation id', () => {
    expect(notificationHref(note({ type: 'MESSAGE_NEW' }), 'en')).toBe('/en/messages');
  });

  it('returns null when there is nowhere to go', () => {
    expect(notificationHref(note({ type: 'SOMETHING_ELSE' }), 'en')).toBeNull();
  });
});
