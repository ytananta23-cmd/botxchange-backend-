import cron from 'node-cron';
import { prisma } from '../prisma';
import { decryptSecret } from '../utils/crypto';
import { getTicker, getCandles, getProducts, placeOrder, getBaseUrl } from './deltaClient';
import { ema, rsi, lastValue, secondLastValue } from './indicators';
import { broadcast } from './wsHub';
import { logger } from '../utils/logger';

/**
 * ============================================================================
 * IMPORTANT — READ BEFORE ENABLING THIS ON A FUNDED ACCOUNT
 * ============================================================================
 * This is a rules-based multi-timeframe trend-following strategy (EMA
 * crossover for trend/entry timing, RSI as a momentum filter, fixed
 * stop-loss and take-profit for exits). It is a considerably more
 * deliberate strategy than a simple price-move trigger, but it is NOT a
 * "guaranteed profit" system — no such thing exists. Trend-following
 * strategies can and do lose money, especially in choppy/range-bound
 * markets, and past behavior on testnet is not a promise of future results.
 * Treat this as a documented, inspectable starting point to observe,
 * backtest against historical data, and refine — not as financial advice
 * or a proven edge.
 *
 * Demo-mode bots (account.type === "demo") place real orders on Delta's
 * TESTNET — paper money, real matching engine, fully automatic.
 * Real-mode bots (account.type === "real") remain a deliberate no-op below
 * until you've watched this run on testnet long enough to trust it.
 * ============================================================================
 */

interface TrendParams {
  /** Higher timeframe used only to establish the prevailing trend direction. */
  trendTimeframe: string;
  /** Lower timeframe used for the actual EMA-crossover entry trigger. */
  entryTimeframe: string;
  emaFast: number;
  emaSlow: number;
  rsiPeriod: number;
  stopLossPercent: number;
  takeProfitPercent: number;
}

const PRESET_TREND: Record<string, TrendParams> = {
  // Slower timeframes, wider stop/target — fewer trades, less noise.
  conservative: { trendTimeframe: '4h', entryTimeframe: '1h', emaFast: 9, emaSlow: 21, rsiPeriod: 14, stopLossPercent: 2.5, takeProfitPercent: 5 },
  optimal: { trendTimeframe: '1h', entryTimeframe: '15m', emaFast: 9, emaSlow: 21, rsiPeriod: 14, stopLossPercent: 1.5, takeProfitPercent: 3 },
  // Faster timeframes, tighter stop/target — more trades, more noise.
  aggressive: { trendTimeframe: '15m', entryTimeframe: '5m', emaFast: 9, emaSlow: 21, rsiPeriod: 14, stopLossPercent: 1, takeProfitPercent: 2 },
};

function resolveParams(bot: { preset: string; paramsJson: string }): TrendParams {
  if (bot.preset === 'custom') {
    try {
      const p = JSON.parse(bot.paramsJson || '{}');
      if (p.trendTimeframe && p.entryTimeframe && p.stopLossPercent && p.takeProfitPercent) {
        return {
          trendTimeframe: p.trendTimeframe,
          entryTimeframe: p.entryTimeframe,
          emaFast: p.emaFast || 9,
          emaSlow: p.emaSlow || 21,
          rsiPeriod: p.rsiPeriod || 14,
          stopLossPercent: p.stopLossPercent,
          takeProfitPercent: p.takeProfitPercent,
        };
      }
    } catch {
      // fall through to default below
    }
  }
  return PRESET_TREND[bot.preset] || PRESET_TREND.optimal;
}

type BotRow = {
  id: string;
  accountId: string;
  account: { type: string; apiKeyEncrypted: string; apiSecretEncrypted: string };
  symbol: string;
  preset: string;
  paramsJson: string;
  entryPrice: number | null;
  positionSide: string | null;
  pnl: number;
};

export function startBotEngine() {
  // Every 30 seconds, evaluate every active bot. Each tick pulls fresh
  // candles and re-derives the trend/entry signal from scratch — the bot
  // has no memory of "why" it's in a position beyond entryPrice/positionSide,
  // which keeps the logic simple to audit and reset.
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const activeBots = await prisma.bot.findMany({
        where: { status: 'active' },
        include: { account: true },
      });
      for (const bot of activeBots) {
        await runBot(bot).catch(err => logger.error(`Bot ${bot.id} tick failed`, err));
      }
    } catch (err) {
      logger.error('botEngine tick failed', err);
    }
  });
}

async function fetchCloses(symbol: string, resolution: string, count: number): Promise<number[]> {
  const to = Math.floor(Date.now() / 1000);
  // Pull comfortably more candles than the longest lookback (EMA-21 + RSI-14
  // both need warm-up bars) needs, so the most recent computed value is stable.
  const from = to - count * resolutionToSeconds(resolution);
  const candles = await getCandles(symbol, resolution, from, to);
  return candles.map(c => c.close);
}

function resolutionToSeconds(resolution: string): number {
  const match = resolution.match(/^(\d+)([mhd])$/);
  if (!match) return 300;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'm') return value * 60;
  if (unit === 'h') return value * 3600;
  return value * 86400;
}

/** Bullish if the fast EMA is above the slow EMA on the most recent candle. */
function trendDirection(closes: number[], fastPeriod: number, slowPeriod: number): 'up' | 'down' | null {
  if (closes.length < slowPeriod + 2) return null;
  const fast = lastValue(ema(closes, fastPeriod));
  const slow = lastValue(ema(closes, slowPeriod));
  if (fast === undefined || slow === undefined) return null;
  return fast > slow ? 'up' : 'down';
}

/** True if the fast EMA just crossed above (bullish) or below (bearish) the slow EMA. */
function crossoverSignal(closes: number[], fastPeriod: number, slowPeriod: number): 'bullish' | 'bearish' | null {
  if (closes.length < slowPeriod + 2) return null;
  const fastArr = ema(closes, fastPeriod);
  const slowArr = ema(closes, slowPeriod);
  const fastNow = lastValue(fastArr);
  const slowNow = lastValue(slowArr);
  const fastPrev = secondLastValue(fastArr);
  const slowPrev = secondLastValue(slowArr);
  if ([fastNow, slowNow, fastPrev, slowPrev].some(v => v === undefined)) return null;
  if (fastPrev! <= slowPrev! && fastNow! > slowNow!) return 'bullish';
  if (fastPrev! >= slowPrev! && fastNow! < slowNow!) return 'bearish';
  return null;
}

async function runBot(bot: BotRow) {
  const params = resolveParams(bot);
  const ticker = await getTicker(bot.symbol).catch(() => null);
  if (!ticker) return;

  if (bot.account.type === 'real') {
    // Real-money order placement is intentionally not enabled by default —
    // see the header comment. Remove this early return only once you've
    // watched this exact strategy run on testnet for a meaningful period.
    await prisma.bot.update({ where: { id: bot.id }, data: { lastRunAt: new Date() } });
    return;
  }

  // --- Manage an existing position: check stop-loss / take-profit first ---
  if (bot.positionSide && bot.entryPrice) {
    const moveFromEntry = ((ticker.price - bot.entryPrice) / bot.entryPrice) * 100;
    const pnlPercent = bot.positionSide === 'long' ? moveFromEntry : -moveFromEntry;

    if (pnlPercent <= -params.stopLossPercent) {
      await closePosition(bot, ticker.price, 'stop-loss');
      return;
    }
    if (pnlPercent >= params.takeProfitPercent) {
      await closePosition(bot, ticker.price, 'take-profit');
      return;
    }

    // Also exit early if the higher-timeframe trend has flipped against the position.
    const trendCloses = await fetchCloses(bot.symbol, params.trendTimeframe, params.emaSlow + 10).catch(() => []);
    const trend = trendDirection(trendCloses, params.emaFast, params.emaSlow);
    if ((bot.positionSide === 'long' && trend === 'down') || (bot.positionSide === 'short' && trend === 'up')) {
      await closePosition(bot, ticker.price, 'trend-reversal');
      return;
    }

    await prisma.bot.update({ where: { id: bot.id }, data: { lastRunAt: new Date() } });
    return;
  }

  // --- Flat: look for a new entry ---
  const [trendCloses, entryCloses]: [number[], number[]] = await Promise.all([
    fetchCloses(bot.symbol, params.trendTimeframe, params.emaSlow + 10),
    fetchCloses(bot.symbol, params.entryTimeframe, Math.max(params.emaSlow, params.rsiPeriod) + 10),
  ]).catch((): [number[], number[]] => [[], []]);

  const trend = trendDirection(trendCloses, params.emaFast, params.emaSlow);
  const crossover = crossoverSignal(entryCloses, params.emaFast, params.emaSlow);
  const rsiNow = lastValue(rsi(entryCloses, params.rsiPeriod));

  let side: 'buy' | 'sell' | null = null;
  // Only take the entry-timeframe crossover if it agrees with the higher
  // timeframe trend, and RSI isn't already at an extreme (avoids buying a
  // blow-off top or shorting a capitulation bottom).
  if (trend === 'up' && crossover === 'bullish' && rsiNow !== undefined && rsiNow < 70) {
    side = 'buy';
  } else if (trend === 'down' && crossover === 'bearish' && rsiNow !== undefined && rsiNow > 30) {
    side = 'sell';
  }

  if (side) {
    await openPosition(bot, side, ticker.price);
  } else {
    await prisma.bot.update({ where: { id: bot.id }, data: { lastRunAt: new Date() } });
  }
}

async function openPosition(bot: BotRow, side: 'buy' | 'sell', price: number) {
  const filled = await executeTestnetTrade(bot, side, price, 'open');
  if (!filled) return;
  await prisma.bot.update({
    where: { id: bot.id },
    data: { positionSide: side === 'buy' ? 'long' : 'short', entryPrice: price, lastRunAt: new Date() },
  });
}

async function closePosition(bot: BotRow, price: number, reason: 'stop-loss' | 'take-profit' | 'trend-reversal') {
  const closingSide: 'buy' | 'sell' = bot.positionSide === 'long' ? 'sell' : 'buy';

  const moveFromEntry = bot.entryPrice ? ((price - bot.entryPrice) / bot.entryPrice) * 100 : 0;
  const pnlPercent = bot.positionSide === 'long' ? moveFromEntry : -moveFromEntry;
  // Simplified running PnL for display purposes; a production engine would
  // track exact per-lot notional rather than a percent-of-entry approximation.
  const pnlDelta = bot.entryPrice ? bot.entryPrice * (pnlPercent / 100) * 0.01 : 0;

  const filled = await executeTestnetTrade(bot, closingSide, price, 'close', pnlDelta);
  if (!filled) return;

  const updated = await prisma.bot.update({
    where: { id: bot.id },
    data: { positionSide: null, entryPrice: null, pnl: bot.pnl + pnlDelta, lastRunAt: new Date() },
  });
  logger.info(`Bot ${bot.id} closed ${bot.positionSide} position (${reason})`, { pnlDelta });
  broadcast(`bots:${bot.accountId}`, { type: 'pnl', botId: bot.id, pnl: updated.pnl, reason });
}

async function executeTestnetTrade(
  bot: BotRow,
  side: 'buy' | 'sell',
  price: number,
  action: 'open' | 'close',
  realizedPnl?: number
): Promise<boolean> {
  const products = await getProducts(getBaseUrl('demo'));
  const product = products.find(p => p.symbol === bot.symbol);
  if (!product) return false;

  const creds = {
    apiKey: decryptSecret(bot.account.apiKeyEncrypted),
    apiSecret: decryptSecret(bot.account.apiSecretEncrypted),
  };

  try {
    await placeOrder(getBaseUrl('demo'), creds, {
      productId: product.productId,
      side,
      size: 1,
      orderType: 'market_order',
    });

    await prisma.order.create({
      data: {
        accountId: bot.accountId,
        botId: bot.id,
        symbol: bot.symbol,
        side,
        size: 1,
        orderType: 'market',
        status: 'closed',
        filledPrice: price,
        // Only the order that actually closes a position realizes PnL —
        // the opening order's PnL is unknown until it's closed.
        ...(realizedPnl !== undefined && { realizedPnl }),
      },
    });

    broadcast(`orders:${bot.accountId}`, { type: 'bot_fill', symbol: bot.symbol, side, action });
    return true;
  } catch (err: any) {
    logger.error(`Bot ${bot.id} testnet order failed`, err);
    return false;
  }
}
