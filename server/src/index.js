import http from 'node:http';
import { config } from './config.js';
import { initDatabase } from './db.js';
import { handleRequest, drainStreamOperations } from './server.js';
import { workerManager } from './worker-manager.js';

// Initialize SQLite tables & schema (Migrations at startup)
try {
  initDatabase();
  await workerManager.reconcileAfterRestart();
  console.log('[Emberstage DB] Database schema initialized successfully.');
} catch (err) {
  console.error('[Emberstage DB Error] Database initialization failed:', err);
  process.exit(1);
}

// Start HTTP server binding loopback (127.0.0.1) by default
const server = http.createServer(handleRequest);

server.listen(config.PORT, config.HOST, () => {
  console.log(`[Emberstage Server] Active and listening on http://${config.HOST}:${config.PORT}`);
  console.log(`[Emberstage Server] Enforced local loopback binding: ${config.HOST}`);
});

// Graceful shutdown support
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Emberstage Server] ${signal} received. Closing HTTP server...`);
  server.close(async () => {
    try {
      await drainStreamOperations();
      const { cleanupPending } = await workerManager.reconcileAfterRestart();
      if (cleanupPending) {
        console.error('[Emberstage Server] Remote cleanup pending; persisted for retry on startup or stop.');
        process.exit(1);
      }
      console.log('[Emberstage Server] Server stopped.');
      process.exit(0);
    } catch (error) {
      console.error('[Emberstage Server] Relay cleanup failed during shutdown.');
      process.exit(1);
    }
  });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
