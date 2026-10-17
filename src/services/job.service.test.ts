import { describe, expect, it } from 'vitest';
import {
  drainJobQueue,
  enqueueJob,
  MemoryJobStore,
  PersistentJobQueue,
  registerJobHandler,
  resetJobQueue,
} from './job.service.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createQueue(options: Partial<ConstructorParameters<typeof PersistentJobQueue>[0]> = {}) {
  return new PersistentJobQueue({
    store: new MemoryJobStore(),
    backoffBaseMs: 1,
    pollIntervalMs: 5,
    ...options,
  });
}

describe('PersistentJobQueue', () => {
  it('runs a queued job with its persisted payload', async () => {
    const seen: unknown[] = [];
    registerJobHandler('email:verification', async (payload) => {
      seen.push(payload);
    });

    const queue = createQueue();
    await queue.enqueue({ type: 'email:verification', payload: { to: 'alice@example.com' } });
    await queue.drain(1000);

    expect(seen).toEqual([{ to: 'alice@example.com' }]);
    expect(queue.size()).toBe(0);
  });

  it('retries a failing job with backoff until it succeeds', async () => {
    let attempts = 0;
    registerJobHandler('email:verification', async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('not yet');
      }
    });

    const queue = createQueue();
    await queue.enqueue({ type: 'email:verification' });
    await queue.drain(2000);

    expect(attempts).toBe(3);
  });

  it('gives up after maxAttempts and still runs later jobs', async () => {
    const ran: string[] = [];
    registerJobHandler('email:verification', async () => {
      ran.push('bad');
      throw new Error('boom');
    });
    registerJobHandler('upload:cleanup', async () => {
      ran.push('good');
    });

    const queue = createQueue({ maxAttempts: 2 });
    await queue.enqueue({ type: 'email:verification' });
    await queue.enqueue({ type: 'upload:cleanup' });
    await queue.drain(2000);

    expect(ran.filter((entry) => entry === 'bad')).toHaveLength(2);
    expect(ran).toContain('good');
  });

  it('fails (without crashing) a job type that has no handler', async () => {
    const queue = createQueue();
    await queue.enqueue({ type: 'email:notification-batch', payload: {} });
    await expect(queue.drain(1000)).resolves.toBeUndefined();
    expect(queue.size()).toBe(0);
  });

  it('runs at most `concurrency` jobs at a time', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let running = 0;
    let maxRunning = 0;
    registerJobHandler('upload:cleanup', async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate;
      running -= 1;
    });

    const queue = createQueue({ concurrency: 1 });
    await queue.enqueue({ type: 'upload:cleanup' });
    await queue.enqueue({ type: 'upload:cleanup' });
    await sleep(20);

    expect(maxRunning).toBe(1);
    expect(queue.size()).toBe(1);

    release();
    await queue.drain(1000);
    expect(queue.size()).toBe(0);
  });

  it('resolves drain immediately when there is nothing to do', async () => {
    const queue = createQueue();
    await expect(queue.drain(50)).resolves.toBeUndefined();
  });
});

describe('MemoryJobStore', () => {
  it('keeps at most one pending job per dedupe key, so a repeat can be scheduled while one runs', async () => {
    const store = new MemoryJobStore();
    const job = {
      type: 'upload:cleanup' as const,
      payload: {},
      runAt: new Date(),
      maxAttempts: 3,
      dedupeKey: 'upload:cleanup',
    };

    await store.insert(job);
    await store.insert(job);
    expect(store.pendingCount()).toBe(1);

    // The running job no longer occupies the key, which is what lets a handler
    // enqueue its own next run.
    const claimed = await store.claim(new Date());
    expect(claimed).not.toBeNull();
    await store.insert(job);
    expect(store.pendingCount()).toBe(1);
  });

  it('reclaims only jobs whose worker lock has gone stale', async () => {
    const store = new MemoryJobStore();
    await store.insert({
      type: 'upload:cleanup',
      payload: {},
      runAt: new Date(),
      maxAttempts: 3,
    });
    await store.claim(new Date());

    expect(await store.recoverStalled(new Date(Date.now() - 60_000))).toBe(0);
    expect(store.pendingCount()).toBe(0);
    expect(await store.recoverStalled(new Date(Date.now() + 1))).toBe(1);
    expect(store.pendingCount()).toBe(1);
  });
});

describe('enqueueJob', () => {
  it('never rejects and drains through the shared queue', async () => {
    registerJobHandler('upload:cleanup', async () => undefined);

    await expect(enqueueJob({ type: 'upload:cleanup' })).resolves.toBeUndefined();
    await expect(drainJobQueue(1000)).resolves.toBeUndefined();
    await resetJobQueue();
  });
});
