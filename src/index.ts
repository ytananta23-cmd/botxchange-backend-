import http from 'http';
import { createApp } from './app';
import { env } from './env';
import { prisma } from './prisma';
import { initWsHub } from './services/wsHub';
import { startBotEngine } from './services/botEngine';
import { logger } from './utils/logger';

const app = createApp();
const server = http.createServer(app);

initWsHub(server);
startBotEngine();

server.listen(env.port, () => {
  logger.info(`BotXchange backend listening on port ${env.port} (${env.nodeEnv})`);
});

// Render sends SIGTERM before restarting/redeploying an instance — closing
// the HTTP server and DB pool cleanly here avoids dropped requests and
// connection leaks during deploys.
async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  server.close(async () => {
    await prisma.$disconnect();
    logger.info('Shutdown complete.');
    process.exit(0);
  });
  // Force-exit if something hangs (open sockets etc.) past 10s.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err);
});
