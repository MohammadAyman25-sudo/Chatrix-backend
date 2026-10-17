process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/chatrix-test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-value-1234';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-1234';
process.env.JWT_ACCESS_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';
// Keep HTTP rate limiters out of the way; they are exercised directly in
// rateLimit.middleware.test.ts via the `enabled` option.
process.env.RATE_LIMIT_ENABLED = 'false';

// Object storage (R2) is required by the env schema; the S3 client is only
// constructed (never called) in tests, so dummy values are enough.
process.env.R2_ACCESS_KEY_ID = 'test-r2-access-key-id';
process.env.R2_SECRET_ACCESS_KEY = 'test-r2-secret-access-key';
process.env.R2_BUCKET = 'test-bucket';
process.env.R2_ENDPOINT = 'https://test-account.r2.cloudflarestorage.com';
process.env.R2_URL = 'https://pub-test.r2.dev';
