import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { env } from './env';
import { prisma } from './prisma';
import { authRouter } from './routes/auth';
import { exchangeRouter } from './routes/exchange';
import { accountsRouter } from './routes/accounts';
import { marketsRouter } from './routes/markets';
import { tradingRouter } from './routes/trading';
import { botsRouter } from './routes/bots';
import { usersRouter } from './routes/users';
import { errorHandler } from './middleware/errorHandler';
import { logger } from './utils/logger';

export function createApp() {
  const app = express();

  // Render sits behind a reverse proxy — needed for correct req.ip / rate limiting.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // Disabled: this API serves JSON only, no HTML, and a strict CSP here
      // would have no effect other than adding noise to responses.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    })
  );

  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
    })
  );
  app.use(express.json());
  app.use(cookieParser());

  // Lightweight request log — one line per request, useful for spotting
  // slow endpoints or unexpected traffic patterns in Render's log viewer.
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path === '/health') return; // keep health-check noise out of logs
      logger.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`);
    });
    next();
  });

  // Auth endpoints get a stricter limit — the main defense against
  // credential-stuffing / brute-force login attempts.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again in a few minutes.' },
  });

  // A gentler global limit so one runaway client can't exhaust the free
  // instance's resources or hit Delta Exchange's own rate limits on our behalf.
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
  });

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', db: 'connected' });
    } catch (err) {
      res.status(503).json({ status: 'degraded', db: 'unreachable' });
    }
  });

  app.use('/api', globalLimiter);
  app.use('/api/auth', authLimiter, authRouter);
  app.use('/api/exchange', exchangeRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/accounts', tradingRouter); // adds /accounts/:id/orders, /positions
  app.use('/api/accounts', botsRouter);    // adds /accounts/:id/bots
  app.use('/api/markets', marketsRouter);
  app.use('/api/users', usersRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  app.use(errorHandler);

  return app;
}
