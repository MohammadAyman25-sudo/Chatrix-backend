import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rateLimit.middleware.js';

function appWithLimiter(options: Parameters<typeof createRateLimiter>[0]) {
  const app = express();
  app.use(
    options.byUser
      ? (req, _res, next) => {
          const header = req.headers['x-user'];
          const id = Array.isArray(header) ? header[0] : header;
          if (id) {
            req.user = { id };
          }
          next();
        }
      : (_req, _res, next) => next(),
  );
  app.use(createRateLimiter(options));
  app.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('createRateLimiter', () => {
  it('allows requests up to the limit and then returns 429', async () => {
    const app = appWithLimiter({ windowMs: 60_000, limit: 2, enabled: true });

    await request(app).get('/ping').expect(200);
    await request(app).get('/ping').expect(200);

    const res = await request(app).get('/ping').expect(429);
    expect(res.body).toEqual({ message: expect.stringMatching(/too many/i) });
    // draft-7 exposes a single combined `RateLimit` header, e.g. "limit=2, ...".
    expect(res.headers['ratelimit']).toContain('limit=2');
  });

  it('does nothing when disabled', async () => {
    const app = appWithLimiter({ windowMs: 60_000, limit: 1, enabled: false });
    await request(app).get('/ping').expect(200);
    await request(app).get('/ping').expect(200);
  });

  it('keys by authenticated user when byUser is set', async () => {
    const app = appWithLimiter({ windowMs: 60_000, limit: 1, enabled: true, byUser: true });

    await request(app).get('/ping').set('x-user', 'alice').expect(200);
    await request(app).get('/ping').set('x-user', 'alice').expect(429);
    // A different user has their own bucket.
    await request(app).get('/ping').set('x-user', 'bob').expect(200);
  });
});
