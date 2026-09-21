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

  it('renders stored translation keys as prose instead of leaking them', () => {
    // The API used to persist `notif.jobStatus.body (CONFIRMED)` verbatim.
    const n = note({
      type: 'JOB_STATUS_CHANGED',
      title_en: 'JOB-WQBVM2',
      title_fr: 'JOB-WQBVM2',
      title_ar: 'JOB-WQBVM2',
      body_en: 'notif.jobStatus.body (CONFIRMED)',
      body_fr: 'notif.jobStatus.body (CONFIRMED)',
      body_ar: 'notif.jobStatus.body (CONFIRMED)',
      data: { status: 'CONFIRMED' },
    });
    const t = (key: string, vars?: Record<string, unknown>) =>
      key === 'notif.jobStatus.body' ? `job is ${vars?.status}` : key;
    expect(notificationText(n, 'en', t).body).toBe('job is CONFIRMED');
    expect(notificationText(n, 'en', t).body).not.toContain('notif.');
  });

  it('appends the translated status to a real title', () => {
    const n = note({ type: 'OFFER_RECEIVED', data: { status: 'PENDING' } });
    const t = (key: string) => (key === 'status.PENDING' ? 'معلّق' : key);
    expect(notificationText(n, 'ar', t).title).toContain('معلّق');
  });

  it('leaves real prose untouched when a translator is supplied', () => {
    const n = note({ type: 'OFFER_RECEIVED', body_en: 'A craftsman sent you an offer.' });
    const t = (key: string) => key;
    expect(notificationText(n, 'en', t).body).toBe('A craftsman sent you an offer.');
  });
});

describe('notificationHref', () => {
  it('routes requests to the request detail', () => {
    const n = note({ type: 'REQUEST_STATUS_CHANGED', reference_type: 'REQUEST', reference_id: 'r1' });
    expect(notificationHref(n, 'ar')).toBe('/ar/requests/r1');
  });

  it('routes on the event type, not the aggregate type', () => {
    // `reference_type` is the aggregate; the real rows look like this.
    const n = note({ type: 'OFFER_RECEIVED', reference_type: 'OFFER', reference_id: 'req-3', data: {} });
    expect(notificationHref(n, 'en')).toBe('/en/requests/req-3');
  });

  it('routes job status changes to the job detail', () => {
    expect(notificationHref(note({ type: 'JOB_STATUS_CHANGED', reference_type: 'JOB', reference_id: 'j1' }), 'fr')).toBe('/fr/jobs/j1');
  });

  it('routes an accepted offer to the job, not the offer id', () => {
    // `reference_id` is the offer; the job id lives in the payload. Using the
    // offer id produced /en/requests/<offer-id>, which 404s.
    const n = note({
      type: 'OFFER_ACCEPTED',
      reference_type: 'OFFER',
      reference_id: 'offer-1',
      data: { jobId: 'job-1', requestId: 'req-1' },
    });
    expect(notificationHref(n, 'en')).toBe('/en/jobs/job-1');
  });

  it('falls back to the request when an accepted offer has no job id', () => {
    const n = note({ type: 'OFFER_ACCEPTED', reference_type: 'OFFER', reference_id: 'req-1', data: {} });
    expect(notificationHref(n, 'ar')).toBe('/ar/requests/req-1');
  });

  it('sends a declined offer back to the request still searching', () => {
    const n = note({
      type: 'OFFER_REJECTED',
      reference_type: 'OFFER',
      reference_id: 'offer-9',
      data: { requestId: 'req-7' },
    });
    expect(notificationHref(n, 'fr')).toBe('/fr/requests/req-7');
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
