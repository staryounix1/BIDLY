/**
 * BIDLY shared domain types.
 * Kept in sync with the PostgreSQL enums in db/migrations/0001_init.sql.
 */

export type UUID = string;
export type ISODateString = string;
export type CurrencyCode = string;

// --- Roles ------------------------------------------------------------
export type UserRole = 'CUSTOMER' | 'PROVIDER' | 'ADMIN';
export type AdminRole = 'SUPER_ADMIN' | 'ADMIN' | 'MODERATOR' | 'FINANCE' | 'SUPPORT';
export type ActorRole = 'CUSTOMER' | 'PROVIDER' | 'ADMIN' | 'SYSTEM';
export type ActorSide = 'CUSTOMER' | 'PROVIDER';

export type UserStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DELETED';
export type VerificationStatus = 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
export type ProviderStatus = 'DRAFT' | 'PENDING_REVIEW' | 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
export type DocStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
export type VerificationType =
  | 'IDENTITY'
  | 'PHONE'
  | 'EMAIL'
  | 'BUSINESS'
  | 'LICENSE'
  | 'INSURANCE'
  | 'BACKGROUND'
  | 'CERTIFICATION';

// --- Catalog ----------------------------------------------------------
export type PricingModel = 'FIXED_QUOTE' | 'OFFER' | 'RANGE' | 'HOURLY' | 'INSPECTION';
export type FieldType =
  | 'TEXT'
  | 'TEXTAREA'
  | 'NUMBER'
  | 'BOOLEAN'
  | 'SELECT'
  | 'MULTISELECT'
  | 'DATE'
  | 'DATETIME'
  | 'PHONE'
  | 'LOCATION'
  | 'ADDRESS'
  | 'PHOTO'
  | 'VIDEO';

export type MediaKind = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';

export type CommissionModel = 'PERCENT' | 'FIXED' | 'PERCENT_PLUS_FIXED';
export type Scope = 'GLOBAL' | 'CATEGORY' | 'SUBCATEGORY' | 'SERVICE' | 'PROVIDER';

// --- Lifecycle --------------------------------------------------------
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
export type NegotiationType = 'COUNTER' | 'ACCEPT' | 'REJECT' | 'WITHDRAW' | 'MESSAGE' | 'SYSTEM';

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

// --- Money ------------------------------------------------------------
export type PaymentStatus =
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'FAILED'
  | 'VOIDED';
export type PaymentMethod = 'CARD' | 'CASH' | 'PAYPAL' | 'BANK_TRANSFER' | 'WALLET';
export type TxnType = 'AUTHORIZE' | 'CAPTURE' | 'VOID' | 'REFUND' | 'WEBHOOK' | 'PING';
export type WalletOwner = 'USER' | 'PROVIDER' | 'PLATFORM';
export type LedgerType =
  | 'JOB_EARNING'
  | 'PLATFORM_COMMISSION'
  | 'REFUND_DEBIT'
  | 'PAYOUT_DEBIT'
  | 'PAYOUT_REVERSAL'
  | 'ADJUSTMENT'
  | 'BONUS'
  | 'PROMOTION'
  | 'PENALTY'
  | 'TOPUP';
export type LedgerDirection = 'CREDIT' | 'DEBIT';
export type PayoutStatus =
  | 'REQUESTED'
  | 'APPROVED'
  | 'PROCESSING'
  | 'PAID'
  | 'REJECTED'
  | 'FAILED'
  | 'CANCELLED';
export type RefundStatus = 'REQUESTED' | 'APPROVED' | 'PROCESSING' | 'COMPLETED' | 'REJECTED' | 'FAILED';

// --- Trust & ops ------------------------------------------------------
export type DisputeStatus =
  | 'OPEN'
  | 'UNDER_REVIEW'
  | 'AWAITING_EVIDENCE'
  | 'RESOLVED'
  | 'REJECTED'
  | 'ESCALATED'
  | 'CLOSED';
export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type SupportStatus = 'OPEN' | 'PENDING' | 'ANSWERED' | 'RESOLVED' | 'CLOSED';
export type NotificationChannel = 'IN_APP' | 'PUSH' | 'EMAIL' | 'SMS';
export type NotificationStatus = 'QUEUED' | 'SENT' | 'DELIVERED' | 'FAILED' | 'READ';
export type MessageKind = 'TEXT' | 'IMAGE' | 'FILE' | 'LOCATION' | 'SYSTEM' | 'OFFER_REFERENCE';
export type ConversationStatus = 'ACTIVE' | 'ARCHIVED' | 'BLOCKED';
export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED' | 'DEAD';

// --- Geo --------------------------------------------------------------
export interface Coordinates {
  lat: number;
  lng: number;
}

export interface AddressInput {
  line1: string;
  line2?: string;
  district?: string;
  cityId?: UUID;
  cityName?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
  lat?: number;
  lng?: number;
  notes?: string;
}

// --- API envelopes ----------------------------------------------------
export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PaginationMeta;
}

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiErrorBody;

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export interface AuthenticatedUser {
  id: UUID;
  email?: string | null;
  phone?: string | null;
  role: UserRole;
  status: UserStatus;
  emailVerified: boolean;
  phoneVerified: boolean;
  providerId?: UUID | null;
  adminRole?: AdminRole | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface JwtAccessPayload {
  sub: UUID;
  role: UserRole;
  sid: UUID;
  typ: 'access';
  iat?: number;
  exp?: number;
}

export interface JwtRefreshPayload {
  sub: UUID;
  sid: UUID;
  fam: UUID;
  typ: 'refresh';
  iat?: number;
  exp?: number;
}

// --- Service field schema (dynamic forms) ------------------------------
export interface ServiceFieldOption {
  id: UUID;
  value: string;
  labelEn: string;
  labelFr?: string | null;
  labelAr?: string | null;
  sortOrder: number;
}

export interface ServiceField {
  id: UUID;
  serviceId: UUID;
  key: string;
  labelEn: string;
  labelFr?: string | null;
  labelAr?: string | null;
  type: FieldType;
  isRequired: boolean;
  sortOrder: number;
  minValue?: number | null;
  maxValue?: number | null;
  minLength?: number | null;
  maxLength?: number | null;
  regex?: string | null;
  defaultValue?: string | null;
  dependsOnKey?: string | null;
  dependsOnValue?: string | null;
  validation: Record<string, unknown>;
  options?: ServiceFieldOption[];
}

export interface ServiceWithFields {
  id: UUID;
  slug: string;
  nameEn: string;
  nameFr?: string | null;
  nameAr?: string | null;
  pricingModel: PricingModel;
  defaultCurrency: CurrencyCode;
  minPriceMinor?: number | null;
  maxPriceMinor?: number | null;
  requiresLocation: boolean;
  requiresDestination: boolean;
  requiresSchedule: boolean;
  fields: ServiceField[];
}

// --- Provider ----------------------------------------------------------
export interface ProviderSummary {
  id: UUID;
  userId: UUID;
  displayName: string;
  avatarUrl?: string | null;
  bio?: string | null;
  status: ProviderStatus;
  verificationStatus: VerificationStatus;
  ratingAvg: number;
  ratingCount: number;
  completedJobs: number;
  responseRateBps: number;
  cancellationRateBps: number;
  isOnline: boolean;
  serviceRadiusKm: number;
  currency: CurrencyCode;
}

// --- Offers ------------------------------------------------------------
export interface OfferSummary {
  id: UUID;
  requestId: UUID;
  providerId: UUID;
  priceMinor: number;
  currency: CurrencyCode;
  message?: string | null;
  etaMinutes?: number | null;
  status: OfferStatus;
  isCounter: boolean;
  parentOfferId?: UUID | null;
  version: number;
  expiresAt?: ISODateString | null;
  createdAt: ISODateString;
}

export interface WalletSummary {
  id: UUID;
  ownerType: WalletOwner;
  ownerId: UUID;
  currency: CurrencyCode;
  availableMinor: number;
  pendingMinor: number;
  lifetimeInMinor: number;
  lifetimeOutMinor: number;
}
