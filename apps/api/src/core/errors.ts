/**
 * Consistent application error taxonomy.
 *
 * Rules:
 *  - every error the API returns has a stable machine-readable `code`
 *  - the user-facing `message` is safe to display and never leaks internals
 *  - technical detail is logged, not returned
 */

export const ERROR_CODES = {
  // 400
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INVALID_INPUT: 'INVALID_INPUT',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  // 401
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID',
  // 403
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  PHONE_NOT_VERIFIED: 'PHONE_NOT_VERIFIED',
  // 404
  NOT_FOUND: 'NOT_FOUND',
  // 409
  CONFLICT: 'CONFLICT',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  DUPLICATE_EMAIL: 'DUPLICATE_EMAIL',
  DUPLICATE_PHONE: 'DUPLICATE_PHONE',
  ILLEGAL_STATE_TRANSITION: 'ILLEGAL_STATE_TRANSITION',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  OPERATION_IN_PROGRESS: 'OPERATION_IN_PROGRESS',
  // 410
  EXPIRED: 'EXPIRED',
  // 422
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  OUT_OF_SERVICE_AREA: 'OUT_OF_SERVICE_AREA',
  PRICE_OUT_OF_RANGE: 'PRICE_OUT_OF_RANGE',
  OFFER_LIMIT_REACHED: 'OFFER_LIMIT_REACHED',
  // 429
  RATE_LIMITED: 'RATE_LIMITED',
  TOO_MANY_ATTEMPTS: 'TOO_MANY_ATTEMPTS',
  // 5xx
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  PAYMENT_PROVIDER_ERROR: 'PAYMENT_PROVIDER_ERROR',
  STORAGE_ERROR: 'STORAGE_ERROR',
  NOTIFICATION_ERROR: 'NOTIFICATION_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

const DEFAULT_MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: 'Some of the information provided is invalid.',
  INVALID_INPUT: 'The request contains invalid data.',
  MALFORMED_REQUEST: 'The request could not be processed.',
  UNAUTHENTICATED: 'You need to sign in to continue.',
  INVALID_CREDENTIALS: 'The email or password is incorrect.',
  TOKEN_EXPIRED: 'Your session has expired. Please sign in again.',
  TOKEN_INVALID: 'Your session is no longer valid. Please sign in again.',
  FORBIDDEN: 'You do not have access to this resource.',
  INSUFFICIENT_PERMISSIONS: 'You do not have permission to perform this action.',
  ACCOUNT_SUSPENDED: 'This account is suspended. Please contact support.',
  EMAIL_NOT_VERIFIED: 'Please verify your email address to continue.',
  PHONE_NOT_VERIFIED: 'Please verify your phone number to continue.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'This action conflicts with the current state.',
  ALREADY_EXISTS: 'This already exists.',
  DUPLICATE_EMAIL: 'An account with this email already exists.',
  DUPLICATE_PHONE: 'An account with this phone number already exists.',
  ILLEGAL_STATE_TRANSITION: 'This action is not allowed at the current stage.',
  IDEMPOTENCY_CONFLICT: 'A different request was already made with this key.',
  OPERATION_IN_PROGRESS: 'This operation is already in progress.',
  EXPIRED: 'This item has expired.',
  BUSINESS_RULE_VIOLATION: 'This action violates a platform rule.',
  INSUFFICIENT_FUNDS: 'There are not enough funds for this operation.',
  OUT_OF_SERVICE_AREA: 'This location is outside the service area.',
  PRICE_OUT_OF_RANGE: 'The price is outside the allowed range for this service.',
  OFFER_LIMIT_REACHED: 'The maximum number of offers has been reached.',
  RATE_LIMITED: 'Too many requests. Please try again shortly.',
  TOO_MANY_ATTEMPTS: 'Too many attempts. Please try again later.',
  INTERNAL_ERROR: 'Something went wrong on our side. Please try again.',
  PAYMENT_PROVIDER_ERROR: 'The payment could not be processed. Please try again.',
  STORAGE_ERROR: 'The file could not be stored. Please try again.',
  NOTIFICATION_ERROR: 'The notification could not be sent.',
  SERVICE_UNAVAILABLE: 'This service is temporarily unavailable.',
};

const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_ERROR: 400,
  INVALID_INPUT: 400,
  MALFORMED_REQUEST: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_INVALID: 401,
  FORBIDDEN: 403,
  INSUFFICIENT_PERMISSIONS: 403,
  ACCOUNT_SUSPENDED: 403,
  EMAIL_NOT_VERIFIED: 403,
  PHONE_NOT_VERIFIED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ALREADY_EXISTS: 409,
  DUPLICATE_EMAIL: 409,
  DUPLICATE_PHONE: 409,
  ILLEGAL_STATE_TRANSITION: 409,
  IDEMPOTENCY_CONFLICT: 409,
  OPERATION_IN_PROGRESS: 409,
  EXPIRED: 410,
  BUSINESS_RULE_VIOLATION: 422,
  INSUFFICIENT_FUNDS: 422,
  OUT_OF_SERVICE_AREA: 422,
  PRICE_OUT_OF_RANGE: 422,
  OFFER_LIMIT_REACHED: 422,
  RATE_LIMITED: 429,
  TOO_MANY_ATTEMPTS: 429,
  INTERNAL_ERROR: 500,
  PAYMENT_PROVIDER_ERROR: 502,
  STORAGE_ERROR: 502,
  NOTIFICATION_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
};

export interface AppErrorOptions {
  code: ErrorCode;
  message?: string;
  statusCode?: number;
  details?: unknown;
  /** Internal-only context; logged, never sent to the client. */
  cause?: unknown;
  /** Marks errors that are safe to show verbatim (already user-facing). */
  expose?: boolean;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;
  public readonly expose: boolean;
  public override readonly cause?: unknown;
  constructor(options: AppErrorOptions) {
    const message = options.message ?? DEFAULT_MESSAGES[options.code] ?? 'An error occurred.';
    super(message);
    this.name = 'AppError';
    this.code = options.code;
    this.statusCode = options.statusCode ?? STATUS_BY_CODE[options.code] ?? 500;
    this.details = options.details;
    this.expose = options.expose ?? true;
    this.cause = options.cause;
    if (Error.captureStackTrace) Error.captureStackTrace(this, AppError);
  }

  static isAppError(err: unknown): err is AppError {
    return err instanceof AppError;
  }
}

// --- Convenience constructors ----------------------------------------

export const badRequest = (message?: string, details?: unknown) =>
  new AppError({ code: ERROR_CODES.INVALID_INPUT, message, details });

export const validationError = (details?: unknown) =>
  new AppError({ code: ERROR_CODES.VALIDATION_ERROR, details });

export const unauthorized = (message?: string) =>
  new AppError({ code: ERROR_CODES.UNAUTHENTICATED, message });

export const invalidCredentials = () =>
  new AppError({ code: ERROR_CODES.INVALID_CREDENTIALS });

export const forbidden = (message?: string) => new AppError({ code: ERROR_CODES.FORBIDDEN, message });

export const insufficientPermissions = () =>
  new AppError({ code: ERROR_CODES.INSUFFICIENT_PERMISSIONS });

export const notFound = (resource = 'Resource') =>
  new AppError({ code: ERROR_CODES.NOT_FOUND, message: `${resource} not found.` });

export const conflict = (message?: string) => new AppError({ code: ERROR_CODES.CONFLICT, message });

/** A resource that exists but is past its validity window (offers, OTPs, invites). */
export const expired = (message?: string) => new AppError({ code: ERROR_CODES.EXPIRED, message });

export const duplicateEmail = () => new AppError({ code: ERROR_CODES.DUPLICATE_EMAIL });

export const duplicatePhone = () => new AppError({ code: ERROR_CODES.DUPLICATE_PHONE });

export const illegalTransition = (from?: string, to?: string) =>
  new AppError({
    code: ERROR_CODES.ILLEGAL_STATE_TRANSITION,
    message: from && to ? `Cannot move from ${from} to ${to}.` : undefined,
  });

export const businessRule = (message?: string, details?: unknown) =>
  new AppError({ code: ERROR_CODES.BUSINESS_RULE_VIOLATION, message, details });

export const priceOutOfRange = (minMinor?: number | null, maxMinor?: number | null) =>
  new AppError({
    code: ERROR_CODES.PRICE_OUT_OF_RANGE,
    message:
      minMinor != null && maxMinor != null
        ? `The price must be between ${minMinor} and ${maxMinor} (minor units).`
        : undefined,
    details: { minMinor, maxMinor },
  });

export const rateLimited = (retryAfterSeconds?: number) =>
  new AppError({
    code: ERROR_CODES.RATE_LIMITED,
    details: retryAfterSeconds ? { retryAfterSeconds } : undefined,
  });

export const internal = (cause?: unknown, message?: string) =>
  new AppError({ code: ERROR_CODES.INTERNAL_ERROR, message, cause, expose: false });

export const serviceUnavailable = (message?: string) =>
  new AppError({ code: ERROR_CODES.SERVICE_UNAVAILABLE, message });

export const paymentProviderError = (cause?: unknown) =>
  new AppError({ code: ERROR_CODES.PAYMENT_PROVIDER_ERROR, cause, expose: false });
