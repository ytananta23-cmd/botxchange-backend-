import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { verifyToken } from '../utils/jwt';
import { getTicker } from './deltaClient';
import { logger } from '../utils/logger';
import { prisma } from '../prisma';

/**
 * A single WS endpoint that clients connect to and then subscribe on:
 *   ws://.../ws?token=<jwt>
 *   -> client sends: { "type": "subscribe", "channel": "market:BTCUSD" }
 *   -> client sends: { "type": "subscribe", "channel": "orders:<accountId>" }
 *   -> server sends: { "channel": "market:BTCUSD", "data": { price, change } }
 *
 * This matches the WS contract from the frontend spec
 * (WS /ws/markets/:symbol and WS /ws/accounts/:id/orders|positions),
 * collapsed into one connection with channel subscriptions, which is
 * simpler to operate on Render's free tier (one process, one socket).
 *
 * AUTHORIZATION: "market:*" channels are public data and open to anyone.
 * "orders:<accountId>" and "bots:<accountId>" channels carry a specific
 * user's private trading data, so a subscribe request for one of those is
 * only honored if the connection's verified JWT belongs to the user who
 * owns that account — otherwise the request is silently dropped. This is
 * re-checked on every subscribe (not just at connect time) since a single
 * socket may be reused to try channels for many different account ids.
 */

interface ConnectionState {
  channels: Set<string>;
  userId: string | null;
}

const connections = new Map<WebSocket, ConnectionState>();
const tickerCache = new Map<string, { price: number; change: number }>();

// Small in-memory cache so we don't hit the DB on every single subscribe
// message for the same (userId, accountId) pair.
const ownershipCache = new Map<string, { owned: boolean; checkedAt: number }>();
const OWNERSHIP_CACHE_TTL_MS = 30_000;

async function userOwnsAccount(userId: string, accountId: string): Promise<boolean> {
  const cacheKey = `${userId}:${accountId}`;
  const cached = ownershipCache.get(cacheKey);
  if (cached && Date.now() - cached.checkedAt < OWNERSHIP_CACHE_TTL_MS) {
    return cached.owned;
  }
  const account = await prisma.exchangeAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });
  const owned = !!account;
  ownershipCache.set(cacheKey, { owned, checkedAt: Date.now() });
  return owned;
}

/** Returns the accountId a private channel refers to, or null if it's not a private channel. */
function privateChannelAccountId(channel: string): string | null {
  if (channel.startsWith('orders:')) return channel.slice('orders:'.length);
  if (channel.startsWith('bots:')) return channel.slice('bots:'.length);
  return null;
}

export function initWsHub(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('error', (err) => logger.error('WebSocket server error', err));

  wss.on('connection', (ws, req) => {
    let userId: string | null = null;
    try {
      const url = new URL(req.url || '', 'http://localhost');
      const token = url.searchParams.get('token');
      if (token) {
        const payload = verifyToken(token); // throws if invalid/expired
        userId = payload.userId;
      }
    } catch {
      // Invalid or missing token: connection stays open for public market
      // data only — userId stays null, so any private-channel subscribe
      // below will be rejected.
    }

    connections.set(ws, { channels: new Set(), userId });

    // A WebSocket with no 'error' listener throws and can crash the whole
    // Node process on an abrupt client disconnect — always attach one.
    ws.on('error', (err) => logger.error('WebSocket client error', err));

    ws.on('message', raw => {
      (async () => {
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return; // ignore malformed messages
        }

        const state = connections.get(ws);
        if (!state) return;

        if (msg.type === 'subscribe' && typeof msg.channel === 'string') {
          const accountId = privateChannelAccountId(msg.channel);
          if (accountId) {
            if (!state.userId || !(await userOwnsAccount(state.userId, accountId))) {
              // Not authenticated, or authenticated as someone who doesn't
              // own this account — refuse the subscription outright.
              ws.send(JSON.stringify({ type: 'error', error: `Not authorized for channel: ${msg.channel}` }));
              return;
            }
          }
          state.channels.add(msg.channel);
        } else if (msg.type === 'unsubscribe' && typeof msg.channel === 'string') {
          state.channels.delete(msg.channel);
        }
      })().catch(err => logger.error('WebSocket message handling failed', err));
    });

    ws.on('close', () => connections.delete(ws));
  });

  // Poll public tickers for every symbol any client is subscribed to and broadcast.
  setInterval(async () => {
    const symbols = new Set<string>();
    for (const state of connections.values()) {
      for (const ch of state.channels) {
        if (ch.startsWith('market:')) symbols.add(ch.slice('market:'.length));
      }
    }
    for (const symbol of symbols) {
      try {
        const ticker = await getTicker(symbol);
        tickerCache.set(symbol, ticker);
        broadcast(`market:${symbol}`, ticker);
      } catch {
        // symbol may be temporarily unavailable; skip this tick
      }
    }
  }, 3000);
}

export function broadcast(channel: string, data: unknown) {
  for (const [ws, state] of connections) {
    if (state.channels.has(channel) && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ channel, data }));
    }
  }
}
