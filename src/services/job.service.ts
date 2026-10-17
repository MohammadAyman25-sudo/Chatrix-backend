import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { Job, type JobType } from '../models/job.model.js';

/**
 * Persistent background job queue. Jobs live in MongoDB, so a restart (or a
 * crash) no longer drops queued work: a worker claims jobs with an atomic
 * `findOneAndUpdate`, retries with exponential backoff persisted in `runAt`, and
 * reclaims jobs whose worker died (`running` with a stale `lockedAt`).
 *
 * The store is swappable: production uses Mongo, tests use an in-memory store so
 * unit tests never need a database. Concurrency is 1, matching the previous
 * in-memory queue and keeping email delivery orderly.
 */

export const JOB_MAX_ATTEMPTS = 3;
export const JOB_BACKOFF_BASE_MS = 1000;
export const JOB_POLL_INTERVAL_MS = 2000;
/** A `running` job locked longer than this is assumed abandoned by a dead worker. */
export const JOB_STALE_MS = 5 * 60 * 1000;

export type JobHandler = (payload: unknown) => Promise<void>;

const handlers = new Map<JobType, JobHandler>();

/**
 * Registers the function that performs a job type. Called at module load by the
 * service that owns the work (email, uploads); a job without a handler fails
 * instead of crashing the worker.
 */
export function registerJobHandler(type: JobType, handler: JobHandler): void {
  handlers.set(type, handler);
}

interface QueuedJob {
  id: string;
  type: JobType;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

export interface NewJob {
  type: JobType;
  payload: unknown;
  runAt: Date;
  maxAttempts: number;
  dedupeKey?: string;
}

export interface JobStore {
  insert(job: NewJob): Promise<void>;
  /** Atomically mark the oldest eligible job `running` and return it. */
  claim(now: Date): Promise<QueuedJob | null>;
  complete(id: string): Promise<void>;
  /** Return a job to `pending` with a later `runAt` (retry). */
  reschedule(id: string, error: string, runAt: Date): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  /** Reclaim jobs whose worker died; returns how many were reclaimed. */
  recoverStalled(cutoff: Date): Promise<number>;
  /** Pending jobs (best effort; used for reporting and tests). */
  pendingCount(): number;
  clear(): Promise<void>;
}

interface MemoryJob {
  id: string;
  type: JobType;
  payload: unknown;
  status: 'pending' | 'running' | 'completed' | 'failed';
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  lockedAt: Date | null;
  dedupeKey?: string;
}

/** In-memory store used by tests (`NODE_ENV=test`) — no database required. */
export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, MemoryJob>();

  async insert(job: NewJob): Promise<void> {
    if (job.dedupeKey) {
      for (const existing of this.jobs.values()) {
        if (existing.status === 'pending' && existing.dedupeKey === job.dedupeKey) {
          return;
        }
      }
    }
    const id = randomUUID();
    this.jobs.set(id, {
      id,
      type: job.type,
      payload: job.payload,
      status: 'pending',
      runAt: job.runAt,
      attempts: 0,
      maxAttempts: job.maxAttempts,
      lockedAt: null,
      ...(job.dedupeKey ? { dedupeKey: job.dedupeKey } : {}),
    });
  }

  async claim(now: Date): Promise<QueuedJob | null> {
    for (const job of this.jobs.values()) {
      if (job.status === 'pending' && job.runAt.getTime() <= now.getTime()) {
        job.status = 'running';
        job.lockedAt = now;
        job.attempts += 1;
        return {
          id: job.id,
          type: job.type,
          payload: job.payload,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
        };
      }
    }
    return null;
  }

  async complete(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) {
      job.status = 'completed';
      job.lockedAt = null;
    }
  }

  async reschedule(id: string, _error: string, runAt: Date): Promise<void> {
    const job = this.jobs.get(id);
    if (job) {
      job.status = 'pending';
      job.runAt = runAt;
      job.lockedAt = null;
    }
  }

  async fail(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job) {
      job.status = 'failed';
      job.lockedAt = null;
    }
  }

  async recoverStalled(cutoff: Date): Promise<number> {
    let reclaimed = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && job.lockedAt && job.lockedAt.getTime() < cutoff.getTime()) {
        job.status = 'pending';
        job.lockedAt = null;
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  pendingCount(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'pending') {
        count += 1;
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    this.jobs.clear();
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 11000
  );
}

/** Production store: durable, atomic claims, survives restarts. */
export class MongoJobStore implements JobStore {
  private pending = 0;

  async insert(job: NewJob): Promise<void> {
    try {
      await Job.create({
        type: job.type,
        payload: job.payload,
        runAt: job.runAt,
        maxAttempts: job.maxAttempts,
        ...(job.dedupeKey ? { dedupeKey: job.dedupeKey } : {}),
      });
      this.pending += 1;
    } catch (error) {
      // The partial unique index keeps one pending job per dedupe key; losing
      // that race means the needed job is already queued.
      if (isDuplicateKeyError(error)) {
        return;
      }
      throw error;
    }
  }

  async claim(now: Date): Promise<QueuedJob | null> {
    const doc = await Job.findOneAndUpdate(
      { status: 'pending', runAt: { $lte: now } },
      { $set: { status: 'running', lockedAt: now }, $inc: { attempts: 1 } },
      { sort: { runAt: 1, _id: 1 }, returnDocument: 'after' },
    );
    if (!doc) {
      return null;
    }
    this.pending = Math.max(0, this.pending - 1);
    return {
      id: String(doc._id),
      type: doc.type as JobType,
      payload: doc.payload,
      attempts: doc.attempts,
      maxAttempts: doc.maxAttempts,
    };
  }

  async complete(id: string): Promise<void> {
    await Job.updateOne(
      { _id: id },
      { $set: { status: 'completed', completedAt: new Date(), lockedAt: null } },
    );
  }

  async reschedule(id: string, error: string, runAt: Date): Promise<void> {
    await Job.updateOne(
      { _id: id },
      { $set: { status: 'pending', runAt, lockedAt: null, lastError: error } },
    );
    this.pending += 1;
  }

  async fail(id: string, error: string): Promise<void> {
    await Job.updateOne(
      { _id: id },
      { $set: { status: 'failed', lockedAt: null, lastError: error } },
    );
  }

  async recoverStalled(cutoff: Date): Promise<number> {
    const result = await Job.updateMany(
      { status: 'running', lockedAt: { $lt: cutoff } },
      { $set: { status: 'pending', lockedAt: null } },
    );
    return result.modifiedCount;
  }

  pendingCount(): number {
    return this.pending;
  }

  async clear(): Promise<void> {
    await Job.deleteMany({});
    this.pending = 0;
  }
}

export interface JobQueueOptions {
  store: JobStore;
  concurrency?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  pollIntervalMs?: number;
  staleMs?: number;
}

export interface EnqueueJobInput {
  type: JobType;
  /** Must be JSON-serializable — it is stored in MongoDB. */
  payload?: unknown;
  /** Earliest time the job may run, relative to now. */
  delayMs?: number;
  maxAttempts?: number;
  /** At most one pending job per key (see `job.model.ts`). */
  dedupeKey?: string;
}

/** `setTimeout` that does not keep the process alive on its own. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class PersistentJobQueue {
  private readonly store: JobStore;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly staleMs: number;

  private active = 0;
  private pumping = false;
  private timer?: NodeJS.Timeout;

  constructor(options: JobQueueOptions) {
    this.store = options.store;
    this.concurrency = options.concurrency ?? 1;
    this.maxAttempts = options.maxAttempts ?? JOB_MAX_ATTEMPTS;
    this.backoffBaseMs = options.backoffBaseMs ?? JOB_BACKOFF_BASE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? JOB_POLL_INTERVAL_MS;
    this.staleMs = options.staleMs ?? JOB_STALE_MS;
  }

  /** Persists a job and immediately tries to run it. */
  async enqueue(input: EnqueueJobInput): Promise<void> {
    await this.store.insert({
      type: input.type,
      payload: input.payload ?? {},
      runAt: new Date(Date.now() + (input.delayMs ?? 0)),
      maxAttempts: input.maxAttempts ?? this.maxAttempts,
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
    });
    void this.pump();
  }

  /** Queued (not yet started) jobs. */
  size(): number {
    return this.store.pendingCount();
  }

  /** Starts the poller and reclaims jobs abandoned by a previous process. */
  start(): void {
    if (this.timer) {
      return;
    }
    void this.store
      .recoverStalled(new Date(Date.now() - this.staleMs))
      .then((count) => {
        if (count > 0) {
          console.warn(`[jobs] reclaimed ${count} stalled job(s) from a previous run`);
        }
      })
      .catch((error: unknown) => {
        console.error('[jobs] stalled-job recovery failed:', error);
      });

    void this.pump();
    this.timer = setInterval(() => void this.pump(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Runs until the queue is idle, or `timeoutMs` elapses. */
  async drain(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.pump();
      if (this.active === 0 && this.store.pendingCount() === 0) {
        return;
      }
      if (Date.now() >= deadline) {
        return;
      }
      await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }

  /** Test helper: stop the poller and drop every job. */
  async reset(): Promise<void> {
    this.stop();
    await this.store.clear();
    this.active = 0;
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.active < this.concurrency) {
        const job = await this.store.claim(new Date());
        if (!job) {
          break;
        }
        this.active += 1;
        void this.run(job).finally(() => {
          this.active -= 1;
          void this.pump();
        });
      }
    } catch (error) {
      console.error('[jobs] failed to claim jobs:', error);
    } finally {
      this.pumping = false;
    }
  }

  private async run(job: QueuedJob): Promise<void> {
    const handler = handlers.get(job.type);
    if (!handler) {
      await this.store.fail(job.id, `No handler registered for job type "${job.type}"`);
      console.error(`[jobs] no handler registered for "${job.type}"`);
      return;
    }

    try {
      await handler(job.payload);
      await this.store.complete(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (job.attempts >= job.maxAttempts) {
        await this.store.fail(job.id, message);
        console.error(`[jobs] "${job.type}" failed after ${job.attempts} attempt(s):`, error);
        return;
      }
      const delayMs = this.backoffBaseMs * 2 ** (job.attempts - 1);
      console.warn(
        `[jobs] "${job.type}" failed (attempt ${job.attempts}/${job.maxAttempts}), retrying in ${delayMs}ms: ${message}`,
      );
      await this.store.reschedule(job.id, message, new Date(Date.now() + delayMs));
    }
  }
}

export const jobQueue = new PersistentJobQueue({
  store: env.NODE_ENV === 'test' ? new MemoryJobStore() : new MongoJobStore(),
});

/**
 * Enqueues a job without blocking the caller. Never rejects: callers sit on
 * request paths, and a lost job is logged rather than failing the request.
 */
export async function enqueueJob(input: EnqueueJobInput): Promise<void> {
  try {
    await jobQueue.enqueue(input);
  } catch (error) {
    console.error(`[jobs] failed to enqueue "${input.type}":`, error);
  }
}

/** Starts the worker (poller + stalled-job recovery). Call once after DB connect. */
export function startJobWorker(): void {
  jobQueue.start();
}

export function stopJobWorker(): void {
  jobQueue.stop();
}

/** Pending jobs across every type (used by `emailQueueSize`). */
export function jobQueueSize(): number {
  return jobQueue.size();
}

/** Waits for in-flight/queued jobs to finish, up to `timeoutMs`. */
export function drainJobQueue(timeoutMs = 5000): Promise<void> {
  return jobQueue.drain(timeoutMs);
}

/** Test helper: drop everything the queue is holding. */
export async function resetJobQueue(): Promise<void> {
  await jobQueue.reset();
}
