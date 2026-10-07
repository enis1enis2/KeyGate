import { CONFIG } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { seedInitialData } from './db/seed.js';
import { buildServer, startRetentionCron } from './server.js';

async function main() {
  console.log('[KeyGate] Initializing database...');
  getDb();

  console.log('[KeyGate] Checking and seeding initial providers & aliases...');
  seedInitialData();

  const server = await buildServer();
  const retentionTimer = startRetentionCron();

  // Run initial retention prune on boot
  try {
    const { RequestLogRepo } = await import('./db/index.js');
    RequestLogRepo.purgeOldLogs(CONFIG.metricsRetentionDays);
  } catch {
    // Retention prune is best-effort on boot; failures are logged by the cron run.
  }

  const port = CONFIG.port;
  const host = CONFIG.host;

  try {
    await server.listen({ port, host });
    console.log(`[KeyGate] Gateway successfully running at http://${host}:${port}`);
    console.log(`[KeyGate] UI Dashboard available at http://${host}:${port}`);
    console.log(`[KeyGate] OpenAI API base URL: http://${host}:${port}/v1`);
    console.log(`[KeyGate] Health check: http://${host}:${port}/healthz`);
    console.log(`[KeyGate] Metrics: http://${host}:${port}/metrics`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }

  // DECISION: Graceful shutdown intercepts termination signals to flush SQLite and close open sockets safely.
  const handleShutdown = async (signal: string) => {
    console.log(`\n[KeyGate] Received ${signal}. Gracefully shutting down...`);
    clearInterval(retentionTimer);
    try {
      await server.close();
      closeDb();
      console.log('[KeyGate] Shutdown complete. Goodbye!');
      process.exit(0);
    } catch (err) {
      console.error('[KeyGate] Error during shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => handleShutdown('SIGINT'));
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[KeyGate] Fatal startup failure:', err);
  process.exit(1);
});
