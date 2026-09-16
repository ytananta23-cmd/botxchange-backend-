import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { requireAuth, requireOwnedAccount } from '../middleware/auth';
import { decryptSecret } from '../utils/crypto';
import { placeOrder, cancelOrder, getPositions, getProducts, getBaseUrl } from '../services/deltaClient';
import { broadcast } from '../services/wsHub';

export const tradingRouter = Router();
tradingRouter.use(requireAuth);

const orderSchema = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  size: z.number().positive(),
  orderType: z.enum(['market', 'limit', 'stop']),
  // For 'limit' orders this is the limit price. For 'stop' orders this is
  // the trigger (stop) price — the order fires as a market order once the
  // trigger is touched. (A stop-*limit* order isn't exposed by the current
  // order ticket, which only collects one price field for 'stop'.)
  limitPrice: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
});

function credsFor(account: any) {
  return {
    apiKey: decryptSecret(account.apiKeyEncrypted),
    apiSecret: decryptSecret(account.apiSecretEncrypted),
  };
}

// POST /accounts/:id/orders
// Places on Delta's testnet for demo accounts, production for real accounts
// — same code path either way, only the base URL (and therefore whether
// real money moves) differs.
tradingRouter.post(
  '/:id/orders',
  requireOwnedAccount,
  asyncHandler(async (req, res) => {
    const account = (req as any).account;
    const data = orderSchema.parse(req.body);

    if (data.orderType !== 'market' && !data.limitPrice) {
      throw new ApiError(
        400,
        data.orderType === 'stop'
          ? 'A trigger price is required for stop orders.'
          : 'limitPrice is required for limit orders.'
      );
    }

    const baseUrl = getBaseUrl(account.type);
    // Testnet and production are separate Delta environments with their
    // own independent product/contract IDs — resolving the symbol against
    // the wrong one causes Delta to reject the order with "invalid_contract".
    const products = await getProducts(baseUrl);
    const product = products.find(p => p.symbol === data.symbol);
    if (!product) throw new ApiError(400, `Unknown symbol: ${data.symbol}`);

    const deltaOrder = await placeOrder(baseUrl, credsFor(account), {
      productId: product.productId,
      side: data.side,
      size: data.size,
      // A 'stop' order executes as a market order once its trigger price
      // is hit — it isn't a distinct order_type on Delta's side, just a
      // market/limit order plus a stop_price (see deltaClient.ts).
      orderType: data.orderType === 'limit' ? 'limit_order' : 'market_order',
      limitPrice: data.orderType === 'limit' ? data.limitPrice : undefined,
      stopPrice: data.orderType === 'stop' ? data.limitPrice : undefined,
      stopLossPrice: data.stopLoss,
      takeProfitPrice: data.takeProfit,
    });

    const order = await prisma.order.create({
      data: {
        accountId: account.id,
        symbol: data.symbol,
        side: data.side,
        size: data.size,
        orderType: data.orderType,
        limitPrice: data.limitPrice,
        stopLoss: data.stopLoss,
        takeProfit: data.takeProfit,
        status: deltaOrder.state === 'closed' ? 'closed' : 'open',
        filledPrice: deltaOrder.average_fill_price ? parseFloat(deltaOrder.average_fill_price) : undefined,
        deltaOrderId: String(deltaOrder.id),
      },
    });

    broadcast(`orders:${account.id}`, { type: 'created', order });
    res.json({ success: true, orderId: order.id });
  })
);

// GET /accounts/:id/orders?status=open|pending|closed
// Served from our local mirror (populated at place/cancel time) rather
// than a live call every time, to stay well within Delta's rate limits.
tradingRouter.get(
  '/:id/orders',
  requireOwnedAccount,
  asyncHandler(async (req, res) => {
    const account = (req as any).account;
    const status = (req.query.status as string) || 'open';

    const orders = await prisma.order.findMany({
      where: { accountId: account.id, status },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json(orders);
  })
);

// DELETE /accounts/:id/orders/:orderId
tradingRouter.delete(
  '/:id/orders/:orderId',
  requireOwnedAccount,
  asyncHandler(async (req, res) => {
    const account = (req as any).account;
    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, accountId: account.id },
    });
    if (!order) throw new ApiError(404, 'Order not found.');
    if (order.status !== 'open') throw new ApiError(400, 'Only open orders can be cancelled.');

    if (order.deltaOrderId) {
      const baseUrl = getBaseUrl(account.type);
      const products = await getProducts(baseUrl);
      const product = products.find(p => p.symbol === order.symbol);
      if (product) {
        await cancelOrder(baseUrl, credsFor(account), order.deltaOrderId, product.productId);
      }
    }

    await prisma.order.update({ where: { id: order.id }, data: { status: 'cancelled' } });
    broadcast(`orders:${account.id}`, { type: 'cancelled', orderId: order.id });
    res.json({ success: true });
  })
);

// GET /accounts/:id/positions — always read live from Delta (testnet or prod).
tradingRouter.get(
  '/:id/positions',
  requireOwnedAccount,
  asyncHandler(async (req, res) => {
    const account = (req as any).account;
    const baseUrl = getBaseUrl(account.type);
    const positions = await getPositions(baseUrl, credsFor(account));

    res.json(
      positions.map((p: any) => ({
        symbol: p.product_symbol,
        side: parseFloat(p.size) > 0 ? 'long' : 'short',
        size: Math.abs(parseFloat(p.size)),
        entryPrice: parseFloat(p.entry_price),
        markPrice: parseFloat(p.mark_price || '0'),
        pnl: parseFloat(p.unrealized_pnl || '0'),
        leverage: parseFloat(p.leverage || '1'),
      }))
    );
  })
);
