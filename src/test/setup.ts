process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/chatrix-test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-value-1234';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-value-1234';
process.env.JWT_ACCESS_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';
