import { describe, expect, it, vi } from 'vitest';
import { JobQueue } from './queue.js';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets pending microtasks/timers run. */
function flush(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('JobQueue', () => {
  it('returns from enqueue before the job finishes', async () => {
    const queue = new JobQueue();
    const gate = deferred();
    let finished = false;

    const id = queue.enqueue('slow', async () => {
      await gate.promise;
      finished = true;
    });

    expect(typeof id).toBe('string');
    expect(finished).toBe(false);

    gate.resolve();
    await queue.drain();
    expect(finished).toBe(true);
  });

  it('runs jobs in FIFO order at concurrency 1', async () => {
    const queue = new JobQueue({ concurrency: 1 });
    const order: number[] = [];
    queue.enqueue('a', async () => {
      order.push(1);
    });
    queue.enqueue('b', async () => {
      order.push(2);
    });
    queue.enqueue('c', async () => {
      order.push(3);
    });

    await queue.drain();
    expect(order).toEqual([1, 2, 3]);
  });

  it('runs up to `concurrency` jobs at once', async () => {
    const queue = new JobQueue({ concurrency: 2 });
    const gate = deferred();
    const started: number[] = [];
    let running = 0;
    let maxRunning = 0;
    const make = (id: number) => async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      started.push(id);
      await gate.promise;
      running -= 1;
    };

    queue.enqueue('a', make(1));
    queue.enqueue('b', make(2));
    queue.enqueue('c', make(3));

    await flush();
    expect(started).toEqual([1, 2]);

    gate.resolve();
    await queue.drain();
    expect(started).toEqual([1, 2, 3]);
    expect(maxRunning).toBe(2);
  });

  it('retries a failing job with backoff until it succeeds', async () => {
    const queue = new JobQueue({ maxAttempts: 3, baseDelayMs: 1 });
    let attempts = 0;
    queue.enqueue('flaky', async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('not yet');
      }
    });

    await queue.drain();
    expect(attempts).toBe(3);
  });

  it('gives up after maxAttempts and reports the failure', async () => {
    const onError = vi.fn();
    const queue = new JobQueue({ maxAttempts: 2, baseDelayMs: 1, onError });
    let attempts = 0;
    queue.enqueue('bad', async () => {
      attempts += 1;
      throw new Error('boom');
    });

    await queue.drain();
    expect(attempts).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ label: 'bad' });
  });

  it('keeps running later jobs after one exhausts its retries', async () => {
    const queue = new JobQueue({ maxAttempts: 1, baseDelayMs: 1 });
    const ran: string[] = [];
    queue.enqueue('bad', async () => {
      throw new Error('boom');
    });
    queue.enqueue('good', async () => {
      ran.push('good');
    });

    await queue.drain();
    expect(ran).toEqual(['good']);
  });

  it('reports the number of waiting jobs', async () => {
    const queue = new JobQueue({ concurrency: 1 });
    const gate = deferred();
    queue.enqueue('a', async () => {
      await gate.promise;
    });
    queue.enqueue('b', async () => {
      await gate.promise;
    });

    expect(queue.size()).toBe(1);
    gate.resolve();
    await queue.drain();
    expect(queue.size()).toBe(0);
  });

  it('drain resolves immediately when there is nothing to do', async () => {
    const queue = new JobQueue();
    await expect(queue.drain()).resolves.toBeUndefined();
  });
});
