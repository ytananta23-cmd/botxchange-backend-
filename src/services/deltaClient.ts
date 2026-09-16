import crypto from 'crypto';
import { env } from '../env';

/**
 * REST client for the Delta Exchange India API (v2) — works against both:
 *   - Production: https://api.india.delta.exchange   (real money)
 *   - Testnet:    https://cdn-ind.testnet.deltaex.org (paper money, same
 *                 matching engine & endpoint shapes — users generate a
 *                 separate key/secret for this at https://testnet.delta.exchange)
 *
 * Every ExchangeAccount row (both type="demo" and type="real") holds its
 * own encrypted API key/secret; which base URL is used is decided purely
 * by getBaseUrl(account.type) below. This means "demo" bots and trades in
 * this app are genuine testnet trades, not a local simulation.
 *
 * Docs: https://docs.delta.exchange/  (swagger: https://docs.delta.exchange/api/swagger_v2.json)
 *
 * Auth scheme (confirmed against Delta's own client libraries):
 *   signature_payload = method + timestamp + requestPath + queryString + body
 *   signature         = HMAC_SHA256(signature_payload, apiSecret) as lowercase hex
 *   headers: { 'api-key': apiKey, 'timestamp': unixSeconds, 'signature': signature }
 *
 * IMPORTANT: Delta's private endpoints, exact field names, and required
 * permissions can change over time. Before relying on this with real money,
 * verify each endpoint against the current swagger spec linked above.
 */

export interface DeltaCredentials {
  apiKey: string;
  apiSecret: string;
}

/** Maps an ExchangeAccount's `type` to the correct Delta API host. */
export function getBaseUrl(accountType: string): string {
  return accountType === 'demo' ? env.deltaTestnetBaseUrl : env.deltaApiBaseUrl;
}

function sign(method: string, path: string, queryString: string, body: string, secret: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = `${method}${timestamp}${path}${queryString}${body}`;
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { timestamp, signature };
}

async function request<T = any>(
  baseUrl: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PUT',
  path: string,
  opts: {
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    creds?: DeltaCredentials;
  } = {}
): Promise<T> {
  const query = opts.query
    ? Object.fromEntries(Object.entries(opts.query).filter(([, v]) => v !== undefined))
    : {};
  const queryString = Object.keys(query).length
    ? '?' + new URLSearchParams(query as Record<string, string>).toString()
    : '';
  const bodyString = opts.body ? JSON.stringify(opts.body) : '';
  const url = `${baseUrl}${path}${queryString}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'botxchange-backend',
  };

  // Only GET requests are safe to silently retry — retrying a POST/DELETE
  // order call on a network hiccup could place or cancel an order twice if
  // the original request actually reached Delta but the response was lost.
  const maxAttempts = method === 'GET' ? 3 : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Signature must be (re)computed per attempt — the timestamp is part of it.
    if (opts.creds) {
      const { timestamp, signature } = sign(method, path, queryString, bodyString, opts.creds.apiSecret);
      headers['api-key'] = opts.creds.apiKey;
      headers['timestamp'] = timestamp;
      headers['signature'] = signature;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: bodyString || undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const json: any = await res.json().catch(() => ({}));

      if (!res.ok || json?.success === false) {
        const rawMessage = json?.error?.message ?? json?.error ?? res.statusText ?? 'Delta Exchange API error';
        const message = typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage);
        const retriable = res.status >= 500 || res.status === 429;
        if (retriable && attempt < maxAttempts) {
          await sleep(300 * attempt);
          continue;
        }
        throw new Error(`Delta Exchange API error (${res.status}): ${message}`);
      }

      return json.result ?? json;
    } catch (err: any) {
      clearTimeout(timeout);
      lastError = err;
      const isAbort = err?.name === 'AbortError';
      if (attempt < maxAttempts) {
        await sleep(300 * attempt);
        continue;
      }
      throw isAbort ? new Error('Delta Exchange API request timed out.') : err;
    }
  }

  throw lastError;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------- Public endpoints (no auth — always production, market data is identical) ----------

export async function getProducts(baseUrl: string = env.deltaApiBaseUrl) {
  const products = await request<any[]>(baseUrl, 'GET', '/v2/products', {
    query: { states: 'live', contract_types: 'perpetual_futures' },
  });
  return products.map((p: any) => ({
    symbol: p.symbol,
    productId: p.id,
    description: p.description,
    tickSize: parseFloat(p.tick_size),
    contractValue: parseFloat(p.contract_value ?? '1'),
    maxLeverage: computeMaxLeverage(p),
  }));
}

/**
 * Delta's product schema for max leverage has been observed under a few
 * different field names/shapes depending on API version. Try each in turn
 * rather than assuming one — and return null (not 0) if none resolve to a
 * sane positive number, so the frontend can show "—" instead of a
 * misleading "0x".
 */
function computeMaxLeverage(p: any): number | null {
  if (p.max_leverage) {
    const v = Math.round(parseFloat(p.max_leverage));
    if (v > 0) return v;
  }
  if (p.default_leverage) {
    const v = Math.round(parseFloat(p.default_leverage));
    if (v > 0) return v;
  }
  const initialMargin = parseFloat(p.initial_margin);
  if (initialMargin > 0) {
    const v = Math.round(1 / initialMargin);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

export async function getTicker(symbol: string) {
  const ticker = await request<any>(env.deltaApiBaseUrl, 'GET', `/v2/tickers/${symbol}`);
  return {
    symbol: ticker.symbol,
    price: parseFloat(ticker.close ?? ticker.mark_price ?? '0'),
    // Delta's docs have shown this field as both `mark_change_24h` and
    // `ltp_change_24h` across API versions — try both rather than assume one.
    change: parseFloat(ticker.mark_change_24h ?? ticker.ltp_change_24h ?? '0'),
  };
}

/**
 * Bulk tickers for every live product in one call (GET /v2/tickers) — used
 * to rank products by real 24h volume without firing one request per
 * symbol (see markets.ts). Returns Delta's raw ticker objects; callers pick
 * the fields they need (symbol, close/mark_price, turnover_usd, etc).
 */
export async function getTickers() {
  return request<any[]>(env.deltaApiBaseUrl, 'GET', '/v2/tickers');
}

export async function getCandles(symbol: string, resolution: string, from: number, to: number) {
  const candles = await request<any[]>(env.deltaApiBaseUrl, 'GET', '/v2/history/candles', {
    query: { symbol, resolution, start: from, end: to },
  });
  return candles.map((c: any) => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

// ---------- Private endpoints (require signed request; baseUrl picks testnet vs prod) ----------

export async function getWalletBalances(baseUrl: string, creds: DeltaCredentials) {
  return request<any[]>(baseUrl, 'GET', '/v2/wallet/balances', { creds });
}

export async function getPositions(baseUrl: string, creds: DeltaCredentials) {
  return request<any[]>(baseUrl, 'GET', '/v2/positions/margined', { creds });
}

export async function getLiveOrders(baseUrl: string, creds: DeltaCredentials, productId?: number) {
  return request<any[]>(baseUrl, 'GET', '/v2/orders', {
    query: { product_id: productId, state: 'open' },
    creds,
  });
}

export async function getOrderHistory(baseUrl: string, creds: DeltaCredentials, productId?: number) {
  return request<any[]>(baseUrl, 'GET', '/v2/orders/history', {
    query: { product_id: productId },
    creds,
  });
}

/**
 * NOTE on stop / bracket fields: Delta's v2 order schema for stop-triggered
 * and bracket (stop-loss / take-profit) orders isn't fully pinned down in
 * this project (see file header) — `stop_price`, `bracket_stop_loss_price`
 * and `bracket_take_profit_price` below are the field names in Delta's
 * published examples as of this writing. Verify against the current
 * swagger spec linked above before relying on this with real money; if the
 * fields have changed, Delta will reject the order with a clear 400 rather
 * than silently ignoring it, since order_type would no longer be valid.
 */
export async function placeOrder(
  baseUrl: string,
  creds: DeltaCredentials,
  order: {
    productId: number;
    side: 'buy' | 'sell';
    size: number;
    orderType: 'market_order' | 'limit_order';
    limitPrice?: number;
    /** Trigger price for a stop order. When present, the order is sent as a stop order. */
    stopPrice?: number;
    /** Optional bracket stop-loss trigger price, attached to the order itself. */
    stopLossPrice?: number;
    /** Optional bracket take-profit trigger price, attached to the order itself. */
    takeProfitPrice?: number;
  }
) {
  const isStop = order.stopPrice !== undefined;
  return request<any>(baseUrl, 'POST', '/v2/orders', {
    body: {
      product_id: order.productId,
      side: order.side,
      size: order.size,
      // A stop order is the same order_type as its underlying execution
      // (market/limit) plus a stop_price trigger — Delta arms it and only
      // sends it to the book once the trigger price is touched.
      order_type: order.orderType,
      limit_price: order.limitPrice?.toString(),
      ...(isStop && {
        stop_price: order.stopPrice!.toString(),
        // "stop_loss_order"/"take_profit_order" trigger type — matches a
        // plain stop-triggered order rather than a trailing stop.
        stop_trigger_method: 'last_traded_price',
      }),
      ...(order.stopLossPrice !== undefined && {
        bracket_stop_loss_price: order.stopLossPrice.toString(),
        bracket_stop_loss_limit_price: order.stopLossPrice.toString(),
      }),
      ...(order.takeProfitPrice !== undefined && {
        bracket_take_profit_price: order.takeProfitPrice.toString(),
        bracket_take_profit_limit_price: order.takeProfitPrice.toString(),
      }),
    },
    creds,
  });
}

export async function cancelOrder(baseUrl: string, creds: DeltaCredentials, orderId: string, productId: number) {
  return request<any>(baseUrl, 'DELETE', '/v2/orders', {
    body: { id: orderId, product_id: productId },
    creds,
  });
}
