/**
 * Minimal in-memory FIFO job queue. Handlers can enqueue slow side effects
 * (sending email, notification fan-out) and return immediately, so the request
 * never waits on them. Failed jobs are retried with exponential backoff.
 *
 * State is per-process and not persisted: a restart drops queued jobs. That is
 * consistent with the rest of the app (in-memory presence and socket rate
 * limiting) and fine for a single instance; a multi-instance or durable setup
 * would need a shared broker.
 */

export interface JobQueueOptions {
  /** How many jobs may run at once. Default `1`. */
  concurrency?: number;
  /** Total attempts per job (first try plus retries). Default `3`. */
  maxAttempts?: number;
  /** Base delay of the exponential backoff between retries, in ms. Default `1000`. */
  baseDelayMs?: number;
  /** Called once a job has exhausted its attempts. */
  onError?: (job: { id: string; label: string }, error: unknown) => void;
}

interface Job {
  id: string;
  label: string;
  run: () => Promise<void>;
  attempts: number;
}

let sequence = 0;

/** `setTimeout` that does not keep the process alive on its own. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class JobQueue {
  private readonly queue: Job[] = [];
  private active = 0;
  private idleWaiters: Array<() => void> = [];
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly onError?: JobQueueOptions['onError'];

  constructor(options: JobQueueOptions = {}) {
    this.concurrency = options.concurrency ?? 1;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.onError = options.onError;
  }

  /** Queues a job and starts processing. Returns the job id immediately. */
  enqueue(label: string, run: () => Promise<void>): string {
    const job: Job = { id: String(++sequence), label, run, attempts: 0 };
    this.queue.push(job);
    void this.pump();
    return job.id;
  }

  /** Jobs waiting to start (in-flight jobs are not counted). */
  size(): number {
    return this.queue.length;
  }

  /** Resolves once nothing is queued and nothing is in flight. */
  drain(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift() as Job;
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.settleIfIdle();
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    while (job.attempts < this.maxAttempts) {
      job.attempts += 1;
      try {
        await job.run();
        return;
      } catch (error) {
        if (job.attempts >= this.maxAttempts) {
          this.onError?.({ id: job.id, label: job.label }, error);
          return;
        }
        await delay(this.baseDelayMs * 2 ** (job.attempts - 1));
      }
    }
  }

  private settleIfIdle(): void {
    if (this.active > 0 || this.queue.length > 0) {
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
