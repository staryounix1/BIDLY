import { z } from 'zod';
/**
 * Environment validation. The process must fail fast and loudly when a
 * required variable is missing or still a placeholder — a half-configured
 * payment or auth stack is worse than a process that refuses to boot.
 */
const placeholder = (v) => v.includes('replace-with') || v.includes('YOUR_') || v.includes('your-');
const requiredSecret = z
    .string()
    .min(32, 'must be at least 32 characters')
    .refine((v) => !placeholder(v), 'still contains a placeholder value');
const optionalString = z.string().optional().default('');
const boolish = z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === 'boolean' ? v : ['true', '1', 'yes'].includes(v.toLowerCase())))
    .default(false);
export const envSchema = z.object({
    // Application
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().default('BIDLY'),
    APP_URL: z.string().url().default('http://localhost:3000'),
    API_URL: z.string().url().default('http://localhost:4000'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    LOG_PRETTY: boolish,
    // Market defaults (overridable at runtime from the DB `settings` table)
    DEFAULT_COUNTRY: z.string().length(2).default('MA'),
    DEFAULT_CURRENCY: z.string().length(3).default('MAD'),
    DEFAULT_LOCALE: z.string().default('ar'),
    SUPPORTED_LOCALES: z.string().default('ar,fr,en'),
    DEFAULT_TIMEZONE: z.string().default('Africa/Casablanca'),
    // Database
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DIRECT_URL: optionalString,
    DATABASE_POOL_MIN: z.coerce.number().int().min(0).default(2),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).default(10),
    DATABASE_SSL: boolish,
    // Supabase
    SUPABASE_URL: optionalString,
    SUPABASE_ANON_KEY: optionalString,
    SUPABASE_SERVICE_ROLE_KEY: optionalString,
    // Auth
    AUTH_SECRET: requiredSecret,
    REFRESH_SECRET: requiredSecret,
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
    ARGON2_MEMORY_KIB: z.coerce.number().int().positive().default(65536),
    ARGON2_TIME_COST: z.coerce.number().int().positive().default(3),
    ARGON2_PARALLELISM: z.coerce.number().int().positive().default(4),
    OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
    OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    MAX_LOGIN_ATTEMPTS: z.coerce.number().int().positive().default(5),
    LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
    // Redis
    REDIS_URL: optionalString,
    REDIS_TLS: boolish,
    CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    // Storage
    STORAGE_DRIVER: z.enum(['local', 's3']).default('s3'),
    S3_ENDPOINT: optionalString,
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('bidly-uploads'),
    S3_ACCESS_KEY_ID: optionalString,
    S3_SECRET_ACCESS_KEY: optionalString,
    S3_FORCE_PATH_STYLE: boolish,
    S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    // Payments
    PAYMENT_PROVIDER: z.string().default('internal'),
    PAYMENT_WEBHOOK_SECRET: optionalString,
    PAYMENT_SANDBOX: boolish,
    CMI_MERCHANT_ID: optionalString,
    CMI_STORE_KEY: optionalString,
    CMI_API_KEY: optionalString,
    STRIPE_SECRET_KEY: optionalString,
    STRIPE_WEBHOOK_SECRET: optionalString,
    PAYPAL_CLIENT_ID: optionalString,
    PAYPAL_CLIENT_SECRET: optionalString,
    // Email / SMS / Push
    EMAIL_PROVIDER: z.string().default('log'),
    EMAIL_FROM: z.string().default('no-reply@bidly.ma'),
    SMTP_HOST: optionalString,
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: optionalString,
    SMTP_PASSWORD: optionalString,
    RESEND_API_KEY: optionalString,
    SMS_PROVIDER: z.string().default('log'),
    SMS_SENDER: z.string().default('BIDLY'),
    TWILIO_ACCOUNT_SID: optionalString,
    TWILIO_AUTH_TOKEN: optionalString,
    TWILIO_FROM_NUMBER: optionalString,
    PUSH_PROVIDER: z.string().default('log'),
    FCM_PROJECT_ID: optionalString,
    FCM_CLIENT_EMAIL: optionalString,
    FCM_PRIVATE_KEY: optionalString,
    // Maps / verify / AI
    MAP_PROVIDER: z.string().default('log'),
    MAP_API_KEY: optionalString,
    MAP_DEFAULT_CENTER_LAT: z.coerce.number().default(34.020882),
    MAP_DEFAULT_CENTER_LNG: z.coerce.number().default(-6.84165),
    VERIFY_PROVIDER: z.string().default('manual'),
    VERIFY_API_KEY: optionalString,
    AI_ENABLED: boolish,
    AI_PROVIDER: optionalString,
    AI_API_KEY: optionalString,
    // Features / demo
    DEMO_MODE: boolish,
    FEATURE_FLAGS: z.string().default(''),
    // Observability
    SENTRY_DSN: optionalString,
    OTEL_ENABLED: boolish,
    // Rate limits
    RATE_LIMIT_ENABLED: boolish,
    RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_API_PER_WINDOW: z.coerce.number().int().positive().default(120),
    RATE_LIMIT_AUTH_PER_WINDOW: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_OTP_PER_WINDOW: z.coerce.number().int().positive().default(5),
    RATE_LIMIT_OFFERS_PER_WINDOW: z.coerce.number().int().positive().default(20),
    // Seed
    SEED_DEV_USERS: boolish,
    SEED_DEV_PASSWORD: optionalString,
});
/**
 * Validate an environment map. In production the auth/refresh secrets must
 * be real; in development we substitute deterministic dev-only values so a
 * fresh clone boots without ceremony, while still never shipping them.
 */
export function validateEnv(raw) {
    const input = { ...raw };
    const isProd = raw.NODE_ENV === 'production';
    if (!isProd) {
        if (!input.AUTH_SECRET || String(input.AUTH_SECRET).length < 32) {
            input.AUTH_SECRET = 'dev-only-auth-secret-'.padEnd(48, 'x');
        }
        if (!input.REFRESH_SECRET || String(input.REFRESH_SECRET).length < 32) {
            input.REFRESH_SECRET = 'dev-only-refresh-secret-'.padEnd(48, 'y');
        }
    }
    const parsed = envSchema.safeParse(input);
    if (!parsed.success) {
        return {
            ok: false,
            errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        };
    }
    const env = parsed.data;
    // Cross-field production guards.
    const errors = [];
    if (isProd) {
        if (env.DEMO_MODE)
            errors.push('DEMO_MODE must be false in production');
        if (env.PAYMENT_SANDBOX && env.PAYMENT_PROVIDER !== 'internal') {
            errors.push('PAYMENT_SANDBOX must be false in production for a live provider');
        }
        if (env.STORAGE_DRIVER === 's3' && !env.S3_ACCESS_KEY_ID) {
            errors.push('S3_ACCESS_KEY_ID is required when STORAGE_DRIVER=s3 in production');
        }
    }
    if (errors.length)
        return { ok: false, errors };
    return { ok: true, env, errors: [] };
}
/**
 * The validated environment.
 *
 * Validation is lazy: importing a constant from this package (for example
 * `LOCALES`) must not require a complete server environment. The first access
 * to `env` performs validation and throws with a readable message if the
 * configuration is unusable — so the server still fails fast at boot, but a
 * pure utility import does not.
 */
let cachedEnv = null;
export function getEnv() {
    if (cachedEnv)
        return cachedEnv;
    const result = validateEnv(process.env);
    if (!result.ok || !result.env) {
        const message = `Invalid environment configuration:\n  - ${result.errors.join('\n  - ')}`;
        // eslint-disable-next-line no-console
        console.error(message);
        throw new Error(message);
    }
    cachedEnv = result.env;
    return cachedEnv;
}
export const env = new Proxy({}, {
    get(_target, prop, receiver) {
        return Reflect.get(getEnv(), prop, receiver);
    },
    has(_target, prop) {
        return prop in getEnv();
    },
    ownKeys() {
        return Reflect.ownKeys(getEnv());
    },
    getOwnPropertyDescriptor(_target, prop) {
        return Reflect.getOwnPropertyDescriptor(getEnv(), prop);
    },
});
//# sourceMappingURL=env.js.map