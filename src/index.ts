import { connectDatabase, disconnectDatabase } from './config/db.js';
import { drainEmailQueue } from './services/email.service.js';
import { startJobWorker, stopJobWorker } from './services/job.service.js';
import { scheduleOrphanUploadCleanup } from './services/upload.service.js';
import { backfillMessageSearchText } from './services/search.service.js';
import { createServer, startServer } from './server.js';

async function main(): Promise<void> {
  await connectDatabase();

  // Persistent background queue (email, upload cleanup). Reclaims jobs left
  // `running` by a previous process and starts the poller.
  startJobWorker();

  // Make sure a pending orphaned-upload sweep exists (no-op if one is queued).
  void scheduleOrphanUploadCleanup();

  // Messages stored before `contentNormalized` existed are invisible to search
  // until they are normalized. Runs before the server starts listening, but a
  // failure is non-fatal: only old messages miss out until the next run.
  try {
    const backfilled = await backfillMessageSearchText();
    if (backfilled > 0) {
      console.log(`Search index: normalized the content of ${backfilled} messages`);
    }
  } catch (error) {
    console.warn('Message search backfill failed:', error);
  }

  const httpServer = createServer();
  await startServer(httpServer);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, shutting down...`);
    httpServer.close(async () => {
      // Stop taking new jobs, flush what is queued (bounded) and only then drop
      // the DB connection the queue is using.
      stopJobWorker();
      await drainEmailQueue();
      await disconnectDatabase();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
