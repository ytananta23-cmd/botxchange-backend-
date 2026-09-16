import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { getProducts, getCandles, getTickers } from '../services/deltaClient';

export const marketsRouter = Router();

let productCache: { data: any[]; fetchedAt: number } | null = null;
const PRODUCT_CACHE_TTL_MS = 30_000;
const TOP_N = 10;

// GET /markets/products
// Returns the top 10 Delta Exchange India perpetual futures by real 24h
// USD turnover — not just "the first 10 the API happened to return".
// Previously this enriched an arbitrary slice of products with one
// getTicker() call per symbol (20 sequential requests); now it fetches
// every ticker in a single bulk call, ranks by volume, then takes the top
// TOP_N — cheaper and gives an actually-meaningful "top 10".
marketsRouter.get(
  '/products',
  asyncHandler(async (_req, res) => {
    if (!productCache || Date.now() - productCache.fetchedAt > PRODUCT_CACHE_TTL_MS) {
      const [products, tickers] = await Promise.all([getProducts(), getTickers()]);
      const tickerBySymbol = new Map(tickers.map((t: any) => [t.symbol, t]));

      const withVolume = products.map(p => {
        const t: any = tickerBySymbol.get(p.symbol);
        // turnover_usd is Delta's 24h turnover already converted to USD —
        // the right common unit to rank USD- and USDT-settled perpetuals
        // against each other. Fall back defensively if it's ever absent.
        const volume = parseFloat(t?.turnover_usd ?? t?.turnover ?? t?.volume ?? '0');
        return {
          ...p,
          price: parseFloat(t?.close ?? t?.mark_price ?? '0'),
          change: parseFloat(t?.mark_change_24h ?? t?.ltp_change_24h ?? '0'),
          volume,
        };
      });

      const top = withVolume
        .sort((a, b) => b.volume - a.volume)
        .slice(0, TOP_N);

      productCache = { data: top, fetchedAt: Date.now() };
    }
    res.json(productCache.data);
  })
);

// GET /markets/:symbol/candles?resolution=5m
marketsRouter.get(
  '/:symbol/candles',
  asyncHandler(async (req, res) => {
    const resolution = (req.query.resolution as string) || '5m';
    const to = Math.floor(Date.now() / 1000);
    const from = to - 60 * 60 * 24; // last 24h
    const candles = await getCandles(req.params.symbol, resolution, from, to);
    res.json(candles);
  })
);
