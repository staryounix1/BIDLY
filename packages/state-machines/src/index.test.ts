import { describe, expect, it } from 'vitest';
import {
  assertJobTransition,
  assertOfferTransition,
  assertRequestTransition,
  canTransitionJob,
  canTransitionOffer,
  canTransitionRequest,
  isJobTerminal,
  isRequestTerminal,
  nextJobStates,
  nextRequestStates,
  TransitionError,
} from './index.js';

describe('request state machine', () => {
  it('allows the happy path', () => {
    expect(canTransitionRequest('DRAFT', 'PUBLISHED')).toBe(true);
    expect(canTransitionRequest('PUBLISHED', 'MATCHING')).toBe(true);
    expect(canTransitionRequest('RECEIVING_OFFERS', 'PROVIDER_SELECTED')).toBe(true);
    expect(canTransitionRequest('CONFIRMED', 'IN_PROGRESS')).toBe(true);
    expect(canTransitionRequest('IN_PROGRESS', 'COMPLETED')).toBe(true);
  });

  it('treats a no-op as valid', () => {
    expect(canTransitionRequest('PUBLISHED', 'PUBLISHED')).toBe(true);
  });

  it('forbids resurrection from terminal states', () => {
    expect(canTransitionRequest('CANCELLED', 'PUBLISHED')).toBe(false);
    expect(canTransitionRequest('EXPIRED', 'MATCHING')).toBe(false);
    expect(canTransitionRequest('COMPLETED', 'IN_PROGRESS')).toBe(false);
  });

  it('throws a typed error on illegal transitions', () => {
    expect(() => assertRequestTransition('DRAFT', 'COMPLETED')).toThrow(TransitionError);
  });

  it('identifies terminal states', () => {
    expect(isRequestTerminal('CANCELLED')).toBe(true);
    expect(isRequestTerminal('PUBLISHED')).toBe(false);
  });

  it('lists next states', () => {
    expect(nextRequestStates('DRAFT')).toContain('PUBLISHED');
    expect(nextRequestStates('CANCELLED')).toEqual([]);
  });
});

describe('offer state machine', () => {
  it('lets the customer accept a pending offer', () => {
    expect(canTransitionOffer('PENDING', 'ACCEPTED')).toBe(true);
  });

  it('lets a provider withdraw a pending offer', () => {
    expect(canTransitionOffer('PENDING', 'WITHDRAWN')).toBe(true);
  });

  it('permits countering then resolving', () => {
    expect(canTransitionOffer('PENDING', 'COUNTERED')).toBe(true);
    expect(canTransitionOffer('COUNTERED', 'ACCEPTED')).toBe(true);
  });

  it('treats accepted offers as final', () => {
    expect(canTransitionOffer('ACCEPTED', 'WITHDRAWN')).toBe(false);
  });

  it('throws on illegal transitions', () => {
    expect(() => assertOfferTransition('REJECTED', 'ACCEPTED')).toThrow(TransitionError);
  });
});

describe('job state machine', () => {
  it('follows the service lifecycle', () => {
    expect(canTransitionJob('CREATED', 'CONFIRMED')).toBe(true);
    expect(canTransitionJob('CONFIRMED', 'PROVIDER_EN_ROUTE')).toBe(true);
    expect(canTransitionJob('PROVIDER_EN_ROUTE', 'PROVIDER_ARRIVED')).toBe(true);
    expect(canTransitionJob('PROVIDER_ARRIVED', 'IN_PROGRESS')).toBe(true);
    expect(canTransitionJob('IN_PROGRESS', 'COMPLETED')).toBe(true);
    expect(canTransitionJob('COMPLETED', 'PAID')).toBe(true);
  });

  it('allows a dispute from an active job', () => {
    expect(canTransitionJob('IN_PROGRESS', 'DISPUTED')).toBe(true);
    expect(canTransitionJob('PAID', 'DISPUTED')).toBe(true);
  });

  it('forbids skipping payment on a refund path', () => {
    expect(canTransitionJob('CREATED', 'PAID')).toBe(false);
  });

  it('forbids leaving a cancelled job', () => {
    expect(canTransitionJob('CANCELLED', 'IN_PROGRESS')).toBe(false);
  });

  it('identifies terminal states', () => {
    expect(isJobTerminal('REFUNDED')).toBe(true);
    expect(isJobTerminal('CANCELLED')).toBe(true);
    // A paid job is not terminal: it can still be disputed or refunded.
    expect(isJobTerminal('PAID')).toBe(false);
    expect(isJobTerminal('IN_PROGRESS')).toBe(false);
  });

  it('lists next states', () => {
    expect(nextJobStates('IN_PROGRESS')).toContain('COMPLETED');
    expect(nextJobStates('REFUNDED')).toEqual([]);
  });

  it('throws on illegal transitions', () => {
    expect(() => assertJobTransition('CREATED', 'PAID')).toThrow(TransitionError);
  });
});
