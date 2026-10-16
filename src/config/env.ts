import 'dotenv/config';
import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(5000),
    MONGODB_URI: z.string().min(1),
    MONGODB_PASSWORD: z.string().min(1).optional(),
    CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
    JWT_ACCESS_SECRET: z.string().min(16),
    JWT_REFRESH_SECRET: z.string().min(16),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

    // Number of proxies in front of the app (e.g. 1 behind a single reverse
    // proxy). Required for correct client IPs for rate limiting. 0 = disabled.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    // Set to "false" to disable all rate limiters (useful in tests/local dev).
    RATE_LIMIT_ENABLED: z
      .string()
      .optional()
      .transform((value) => value !== 'false'),
    // When true, registration rejects passwords found in the Have I Been Pwned
    // range API (k-anonymity). The bundled common-password list always applies.
    PWNED_PASSWORD_CHECK_ENABLED: z
      .string()
      .optional()
      .transform((value) => value !== 'false'),

    // Email verification. When enabled (the default) users must verify their
    // email before they can log in. Set to "false" to skip verification
    // (local dev / tests).
    EMAIL_VERIFICATION_ENABLED: z
      .string()
      .optional()
      .transform((value) => value !== 'false'),
    // Sender shown on outgoing mail ("Name <address>").
    EMAIL_FROM: z.string().min(1).default('Chatrix <onboarding@resend.dev>'),
    // Resend API key (https://resend.com). When unset, a console mailer logs
    // the message (including the verification link) instead of sending it.
    RESEND_API_KEY: z.string().min(1).optional(),

    MEDIA_DISK: z.enum(['local', 'r2']).default('local'),
    R2_ACCESS_KEY_ID: z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    R2_BUCKET: z.string().min(1).optional(),
    R2_ENDPOINT: z.string().url().optional(),
    R2_URL: z.string().url().optional(),
    R2_REGION: z.string().default('auto'),
  })
  .superRefine((value, ctx) => {
    if (value.MEDIA_DISK !== 'r2') {
      return;
    }
    const required = [
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
      'R2_ENDPOINT',
      'R2_URL',
    ] as const;
    for (const key of required) {
      if (!value[key]) {
        ctx.addIssue({
          code: 'custom',
          message: `${key} is required when MEDIA_DISK=r2`,
          path: [key],
        });
      }
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(JSON.stringify(parsed.error.issues, null, 2));
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';

export const DB_PASSWORD_PLACEHOLDER = '<db_password>';

// MONGODB_URI may contain the literal `<db_password>` placeholder; substitute the
// URL-encoded MONGODB_PASSWORD before connecting.
function resolveMongoUri(uri: string, password: string | undefined): string {
  if (!uri.includes(DB_PASSWORD_PLACEHOLDER)) {
    return uri;
  }
  if (!password) {
    console.error(
      `MONGODB_URI contains "${DB_PASSWORD_PLACEHOLDER}" but MONGODB_PASSWORD is not set.`,
    );
    process.exit(1);
  }
  return uri.replaceAll(DB_PASSWORD_PLACEHOLDER, encodeURIComponent(password));
}

export const mongoUri = resolveMongoUri(env.MONGODB_URI, env.MONGODB_PASSWORD);
