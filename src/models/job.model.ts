import { Schema, model } from 'mongoose';

/**
 * Kinds of background work the persistent queue understands. Every job type
 * must have a handler registered by its owning service (see `job.service.ts`);
 * adding a type here without a handler makes the job fail (never crash).
 */
export const JOB_TYPES = [
  'email:verification',
  'email:notification-batch',
  'email:message-notification',
  'upload:cleanup',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['pending', 'running', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * One durable unit of background work. Unlike the old in-memory queue these
 * survive a restart: `pending` + `runAt` make retries and delayed jobs
 * persistent, `running` + `lockedAt` let a crashed worker's job be reclaimed.
 */
const jobSchema = new Schema(
  {
    type: { type: String, required: true, enum: [...JOB_TYPES] },
    /** Handler-specific, must be JSON-serializable (it is stored in Mongo). */
    payload: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, required: true, enum: [...JOB_STATUSES], default: 'pending' },
    /** When the job becomes eligible to run (retry backoff sets this forward). */
    runAt: { type: Date, required: true, default: () => new Date() },
    /** Attempts started so far; incremented atomically when a worker claims it. */
    attempts: { type: Number, required: true, default: 0 },
    maxAttempts: { type: Number, required: true, default: 3 },
    /** Set while a worker runs the job; a stale value means the worker died. */
    lockedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    /**
     * Optional idempotency key. A partial unique index guarantees at most one
     * *pending* job per key, so re-scheduling (e.g. the repeating upload
     * cleanup) can enqueue the next run while the current one is still running.
     */
    dedupeKey: { type: String },
  },
  { timestamps: true },
);

// Claiming order and stalled-job recovery.
jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ status: 1, lockedAt: 1 });
jobSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending', dedupeKey: { $type: 'string' } },
  },
);

export const Job = model('Job', jobSchema);
