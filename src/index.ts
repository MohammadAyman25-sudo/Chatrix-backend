import { connectDatabase, disconnectDatabase } from './config/db.js';
import { drainEmailQueue } from './services/email.service.js';
import { createServer, startServer } from './server.js';

async function main(): Promise<void> {
  await connectDatabase();

  const httpServer = createServer();
  await startServer(httpServer);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, shutting down...`);
    httpServer.close(async () => {
      // Flush queued email (bounded) before dropping the DB connection.
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
