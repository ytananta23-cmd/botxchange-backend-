import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { requireAuth, requireOwnedAccount } from '../middleware/auth';
import { broadcast } from '../services/wsHub';

export const botsRouter = Router();
botsRouter.use(requireAuth);

// GET /accounts/:id/bots?status=active|stopped&mode=real|demo
botsRouter.get(
  '/:id/bots',
  requireOwnedAccount,
  asyncHandler(async (req, res) => {
    const account = (req as any).account;
    const status = req.query.status as string | undefined;
    const mode = req.query.mode as string | undefined;

    const bots = await prisma.bot.findMany({
      where: { accountId: account.id, ...(status && { status }), ...(mode && { mode }) },
      orderBy: { createdAt: 'desc' },
    });

    res.json(
      bots.map(b => ({
        id: b.id,
        name: b.name,
        symbol: b.symbol,
        strategyType: b.strategyType,
        preset: b.preset,
        status: b.status,
        mode: b.mode,
        pnl: b.pnl,
        positionSide: b.positionSide,
        uptime: formatUptime(b.createdAt),
        createdAt: b.createdAt,
        // Real-mode bots are intentionally a no-op in botEngine.ts until
        // the strategy has been validated on testnet — surfaced here so
        // the frontend can warn the user instead of implying it's trading.
        liveTradingEnabled: b.mode !== 'real',
      }))
    );
  })
);

const createBotSchema = z.object({
  symbol: z.string(),
  preset: z.enum(['conservative', 'optimal', 'aggressive', 'custom']),
  params: z.record(z.any()).optional(),
});

// POST /accounts/:id/bots
// A bot's mode always matches the account it's created on — a bot on a
// "demo" account trades Delta's testnet, a bot on a "real" account trades
// production. There's no separate mode flag to keep in sync with the
// account, which avoids the mismatch this used to allow.
botsRouter.post(
  '/:id/bots',
  requireOwnedAccount,
  asyncHandler(async (req, res) => {
    const account = (req as any).account;
    const data = createBotSchema.parse(req.body);

    const bot = await prisma.bot.create({
      data: {
        accountId: account.id,
        name: `${data.symbol} Trend Bot`,
        symbol: data.symbol,
        strategyType: 'trend',
        preset: data.preset,
        paramsJson: JSON.stringify(data.params || {}),
        mode: account.type,
        status: 'active',
      },
    });

    res.json({ success: true, botId: bot.id });
    broadcast(`bots:${account.id}`, { type: 'created', botId: bot.id });
  })
);

// POST /accounts/:id/bots/:botId/stop
botsRouter.post(
  '/:id/bots/:botId/stop',
  requireOwnedAccount,
  asyncHandler(async (req, res) => {
    await setBotStatus(req, 'stopped');
    res.json({ success: true });
  })
);

// POST /accounts/:id/bots/:botId/start
botsRouter.post(
  '/:id/bots/:botId/start',
  requireOwnedAccount,
  asyncHandler(async (req, res) => {
    await setBotStatus(req, 'active');
    res.json({ success: true });
  })
);

async function setBotStatus(req: any, status: 'active' | 'stopped') {
  const account = req.account;
  const bot = await prisma.bot.findFirst({ where: { id: req.params.botId, accountId: account.id } });
  if (!bot) throw new ApiError(404, 'Bot not found.');
  await prisma.bot.update({ where: { id: bot.id }, data: { status } });
  broadcast(`bots:${account.id}`, { type: 'status', botId: bot.id, status });
}

// GET /accounts/:id/bots/:botId/performance?range=1d|7d|30d
botsRouter.get(
  '/:id/bots/:botId/performance',
  requireOwnedAccount,
  asyncHandler(async (req, res) => {
    const account = (req as any).account;
    const bot = await prisma.bot.findFirst({ where: { id: req.params.botId, accountId: account.id } });
    if (!bot) throw new ApiError(404, 'Bot not found.');

    const RANGE_DAYS: Record<string, number> = { '1d': 1, '7d': 7, '30d': 30 };
    const range = req.query.range as string | undefined;
    const since = range && RANGE_DAYS[range]
      ? new Date(Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000)
      : null;

    // Attributed via Order.botId (set when the bot itself places a trade —
    // see botEngine.ts) rather than by matching symbol, so trades placed
    // manually or by a different bot on the same symbol aren't miscounted
    // as this bot's activity.
    const trades = await prisma.order.findMany({
      where: {
        botId: bot.id,
        status: 'closed',
        ...(since && { createdAt: { gte: since } }),
      },
      select: { realizedPnl: true },
    });

    // With a recognized range: sum this window's trades only (realizedPnl
    // is null on any order placed before this column existed, so those
    // count as 0 rather than breaking the sum). With no/unrecognized
    // range: fall back to the bot's all-time running total, unchanged
    // from before this endpoint understood ranges at all.
    const profit = since
      ? trades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0)
      : bot.pnl;

    res.json({ profit, trades: trades.length });
  })
);

function formatUptime(createdAt: Date): string {
  const ms = Date.now() - createdAt.getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  return `${hours}h`;
}
