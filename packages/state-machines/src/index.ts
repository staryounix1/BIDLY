/**
 * BIDLY state machines.
 *
 * The database enforces these same transitions with triggers; these pure
 * functions are what the API uses for fast, testable, descriptive errors.
 * Keep them in lockstep with db/migrations/0001_init.sql.
 */

export type RequestStatus =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'MATCHING'
  | 'RECEIVING_OFFERS'
  | 'PROVIDER_SELECTED'
  | 'CONFIRMED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'DISPUTED'
  | 'REFUNDED'
  | 'FAILED';

export type OfferStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED' | 'COUNTERED';

export type JobStatus =
  | 'CREATED'
  | 'CONFIRMED'
  | 'PROVIDER_EN_ROUTE'
  | 'PROVIDER_ARRIVED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'CANCELLED'
  | 'DISPUTED'
  | 'REFUNDED'
  | 'FAILED';

export class TransitionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Illegal ${entity} transition: ${from} -> ${to}`);
    this.name = 'TransitionError';
  }
}

const REQUEST_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  DRAFT: ['PUBLISHED', 'CANCELLED', 'EXPIRED'],
  PUBLISHED: ['MATCHING', 'CANCELLED', 'EXPIRED', 'FAILED'],
  MATCHING: ['RECEIVING_OFFERS', 'CANCELLED', 'EXPIRED', 'FAILED', 'PUBLISHED'],
  RECEIVING_OFFERS: ['PROVIDER_SELECTED', 'MATCHING', 'CANCELLED', 'EXPIRED', 'FAILED'],
  PROVIDER_SELECTED: ['CONFIRMED', 'RECEIVING_OFFERS', 'CANCELLED', 'FAILED'],
  CONFIRMED: ['IN_PROGRESS', 'CANCELLED', 'DISPUTED', 'FAILED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED', 'DISPUTED', 'FAILED'],
  COMPLETED: ['DISPUTED', 'REFUNDED'],
  CANCELLED: [],
  EXPIRED: [],
  DISPUTED: ['COMPLETED', 'REFUNDED', 'CANCELLED'],
  REFUNDED: [],
  FAILED: [],
};

const OFFER_TRANSITIONS: Record<OfferStatus, OfferStatus[]> = {
  PENDING: ['ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'COUNTERED'],
  COUNTERED: ['REJECTED', 'WITHDRAWN', 'EXPIRED', 'ACCEPTED'],
  ACCEPTED: [],
  REJECTED: [],
  WITHDRAWN: [],
  EXPIRED: [],
};

const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  CREATED: ['CONFIRMED', 'CANCELLED', 'FAILED'],
  CONFIRMED: ['PROVIDER_EN_ROUTE', 'IN_PROGRESS', 'CANCELLED', 'DISPUTED', 'FAILED'],
  PROVIDER_EN_ROUTE: ['PROVIDER_ARRIVED', 'CANCELLED', 'DISPUTED', 'FAILED'],
  PROVIDER_ARRIVED: ['IN_PROGRESS', 'CANCELLED', 'DISPUTED', 'FAILED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED', 'DISPUTED', 'FAILED'],
  COMPLETED: ['PAYMENT_PENDING', 'PAID', 'DISPUTED'],
  PAYMENT_PENDING: ['PAID', 'FAILED', 'DISPUTED'],
  PAID: ['DISPUTED', 'REFUNDED'],
  CANCELLED: [],
  DISPUTED: ['PAID', 'REFUNDED', 'COMPLETED', 'CANCELLED'],
  REFUNDED: [],
  FAILED: [],
};

export const REQUEST_TERMINAL: RequestStatus[] = ['CANCELLED', 'EXPIRED', 'REFUNDED', 'FAILED'];
export const JOB_TERMINAL: JobStatus[] = ['CANCELLED', 'REFUNDED', 'FAILED'];

export function canTransitionRequest(from: RequestStatus, to: RequestStatus): boolean {
  if (from === to) return true;
  return REQUEST_TRANSITIONS[from].includes(to);
}

export function assertRequestTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransitionRequest(from, to)) throw new TransitionError('request', from, to);
}

export function canTransitionOffer(from: OfferStatus, to: OfferStatus): boolean {
  if (from === to) return true;
  return OFFER_TRANSITIONS[from].includes(to);
}

export function assertOfferTransition(from: OfferStatus, to: OfferStatus): void {
  if (!canTransitionOffer(from, to)) throw new TransitionError('offer', from, to);
}

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  if (from === to) return true;
  return JOB_TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to)) throw new TransitionError('job', from, to);
}

export function nextRequestStates(from: RequestStatus): RequestStatus[] {
  return [...REQUEST_TRANSITIONS[from]];
}

export function nextOfferStates(from: OfferStatus): OfferStatus[] {
  return [...OFFER_TRANSITIONS[from]];
}

export function nextJobStates(from: JobStatus): JobStatus[] {
  return [...JOB_TRANSITIONS[from]];
}

export function isRequestTerminal(status: RequestStatus): boolean {
  return REQUEST_TERMINAL.includes(status);
}

export function isJobTerminal(status: JobStatus): boolean {
  return JOB_TERMINAL.includes(status);
}

/**
 * Cancellation cost depends on how far the job progressed. The authoritative
 * fee values come from the `cancellation_policies` table; this only maps a
 * job status to the policy "stage" key the resolver should look up.
 */
export function cancellationStageFor(jobStatus: JobStatus): string {
  const map: Partial<Record<JobStatus, string>> = {
    CREATED: 'PROVIDER_SELECTED',
    CONFIRMED: 'CONFIRMED',
    PROVIDER_EN_ROUTE: 'PROVIDER_EN_ROUTE',
    PROVIDER_ARRIVED: 'PROVIDER_EN_ROUTE',
    IN_PROGRESS: 'IN_PROGRESS',
  };
  return map[jobStatus] ?? 'CONFIRMED';
}
