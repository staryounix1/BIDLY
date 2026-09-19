/**
 * Platform constants that are NOT business configuration.
 * Anything an admin should be able to change lives in the database
 * `settings` / `commission_rules` / `cancellation_policies` tables.
 */
export declare const APP_NAME = "BIDLY";
export declare const ROLES: {
    readonly CUSTOMER: "CUSTOMER";
    readonly PROVIDER: "PROVIDER";
    readonly ADMIN: "ADMIN";
};
export type UserRole = (typeof ROLES)[keyof typeof ROLES];
export declare const ADMIN_ROLES: {
    readonly SUPER_ADMIN: "SUPER_ADMIN";
    readonly ADMIN: "ADMIN";
    readonly MODERATOR: "MODERATOR";
    readonly FINANCE: "FINANCE";
    readonly SUPPORT: "SUPPORT";
};
export type AdminRole = (typeof ADMIN_ROLES)[keyof typeof ADMIN_ROLES];
export declare const LOCALES: readonly ["ar", "fr", "en"];
export type Locale = (typeof LOCALES)[number];
export declare const DEFAULT_LOCALE: Locale;
export declare const FALLBACK_LOCALE: Locale;
/** Minor-unit scale per currency. Architected for many, launching with MAD. */
export declare const MINOR_UNITS: Record<string, number>;
export declare const DEFAULT_CURRENCY = "MAD";
export declare const PAGINATION: {
    readonly DEFAULT_LIMIT: 20;
    readonly MAX_LIMIT: 100;
};
export declare const UPLOAD_LIMITS: {
    readonly MAX_IMAGE_MB: 10;
    readonly MAX_VIDEO_MB: 50;
    readonly ALLOWED_IMAGE_TYPES: readonly ["image/jpeg", "image/png", "image/webp"];
    readonly ALLOWED_VIDEO_TYPES: readonly ["video/mp4", "video/quicktime", "video/webm"];
    readonly ALLOWED_DOC_TYPES: readonly ["application/pdf"];
};
export declare const SESSION: {
    readonly ACCESS_TOKEN_TTL_MINUTES: 15;
    readonly REFRESH_TOKEN_TTL_DAYS: 30;
    readonly OTP_LENGTH: 6;
    readonly OTP_TTL_SECONDS: 300;
    readonly MAX_LOGIN_ATTEMPTS: 5;
    readonly LOCKOUT_MINUTES: 15;
};
export declare const RATE_LIMITS: {
    readonly AUTH: {
        readonly windowSeconds: 60;
        readonly max: 10;
    };
    readonly OTP: {
        readonly windowSeconds: 60;
        readonly max: 5;
    };
    readonly API: {
        readonly windowSeconds: 60;
        readonly max: 120;
    };
    readonly OFFERS: {
        readonly windowSeconds: 60;
        readonly max: 20;
    };
    readonly UPLOADS: {
        readonly windowSeconds: 60;
        readonly max: 30;
    };
};
export declare const HTTP_STATUS: {
    readonly OK: 200;
    readonly CREATED: 201;
    readonly NO_CONTENT: 204;
    readonly BAD_REQUEST: 400;
    readonly UNAUTHORIZED: 401;
    readonly FORBIDDEN: 403;
    readonly NOT_FOUND: 404;
    readonly CONFLICT: 409;
    readonly GONE: 410;
    readonly UNPROCESSABLE: 422;
    readonly TOO_MANY_REQUESTS: 429;
    readonly INTERNAL: 500;
    readonly BAD_GATEWAY: 502;
    readonly SERVICE_UNAVAILABLE: 503;
};
/** Geolocation defaults for the Rabat/Salé/Témara launch market. */
export declare const GEO: {
    readonly LAUNCH_MARKET_CENTER: {
        readonly lat: 34.020882;
        readonly lng: -6.84165;
    };
    readonly DEFAULT_RADIUS_KM: 10;
    readonly MAX_RADIUS_KM: 40;
    readonly EARTH_RADIUS_KM: 6371;
};
//# sourceMappingURL=constants.d.ts.map