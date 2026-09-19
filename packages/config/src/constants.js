/**
 * Platform constants that are NOT business configuration.
 * Anything an admin should be able to change lives in the database
 * `settings` / `commission_rules` / `cancellation_policies` tables.
 */
export const APP_NAME = 'BIDLY';
export const ROLES = {
    CUSTOMER: 'CUSTOMER',
    PROVIDER: 'PROVIDER',
    ADMIN: 'ADMIN',
};
export const ADMIN_ROLES = {
    SUPER_ADMIN: 'SUPER_ADMIN',
    ADMIN: 'ADMIN',
    MODERATOR: 'MODERATOR',
    FINANCE: 'FINANCE',
    SUPPORT: 'SUPPORT',
};
export const LOCALES = ['ar', 'fr', 'en'];
export const DEFAULT_LOCALE = 'ar';
export const FALLBACK_LOCALE = 'en';
/** Minor-unit scale per currency. Architected for many, launching with MAD. */
export const MINOR_UNITS = {
    MAD: 2,
    USD: 2,
    EUR: 2,
    XOF: 0,
    JPY: 0,
};
export const DEFAULT_CURRENCY = 'MAD';
export const PAGINATION = {
    DEFAULT_LIMIT: 20,
    MAX_LIMIT: 100,
};
export const UPLOAD_LIMITS = {
    MAX_IMAGE_MB: 10,
    MAX_VIDEO_MB: 50,
    ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
    ALLOWED_VIDEO_TYPES: ['video/mp4', 'video/quicktime', 'video/webm'],
    ALLOWED_DOC_TYPES: ['application/pdf'],
};
export const SESSION = {
    ACCESS_TOKEN_TTL_MINUTES: 15,
    REFRESH_TOKEN_TTL_DAYS: 30,
    OTP_LENGTH: 6,
    OTP_TTL_SECONDS: 300,
    MAX_LOGIN_ATTEMPTS: 5,
    LOCKOUT_MINUTES: 15,
};
export const RATE_LIMITS = {
    AUTH: { windowSeconds: 60, max: 10 },
    OTP: { windowSeconds: 60, max: 5 },
    API: { windowSeconds: 60, max: 120 },
    OFFERS: { windowSeconds: 60, max: 20 },
    UPLOADS: { windowSeconds: 60, max: 30 },
};
export const HTTP_STATUS = {
    OK: 200,
    CREATED: 201,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    GONE: 410,
    UNPROCESSABLE: 422,
    TOO_MANY_REQUESTS: 429,
    INTERNAL: 500,
    BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503,
};
/** Geolocation defaults for the Rabat/Salé/Témara launch market. */
export const GEO = {
    LAUNCH_MARKET_CENTER: { lat: 34.020882, lng: -6.84165 },
    DEFAULT_RADIUS_KM: 10,
    MAX_RADIUS_KM: 40,
    EARTH_RADIUS_KM: 6371,
};
//# sourceMappingURL=constants.js.map