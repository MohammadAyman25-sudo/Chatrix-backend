import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGODB_URI: z.string().min(1),
  MONGODB_PASSWORD: z.string().min(1).optional(),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
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
