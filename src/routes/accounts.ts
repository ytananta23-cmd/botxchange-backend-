import { Router } from 'express';
import { prisma } from '../prisma';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { requireAuth, requireOwnedAccount } from '../middleware/auth';
import { decryptSecret } from '../utils/crypto';
import { getWalletBalances, getPositions, getBaseUrl } from '../services/deltaClient';

export const accountsRouter = Router();
accountsRouter.use(requireAuth);

// GET /accounts/:id/balance
// Both demo (testnet) and real (production) accounts are read live from
// Delta Exchange India — there is no local fake balance anymore.
accountsRouter.get(
  '/:id/balance',
  requireOwnedAccount,
  asyncHandler(async (req, res) => {
    const account = (req as any).account;
    const baseUrl = getBaseUrl(account.type);
    const creds = {
      apiKey: decryptSecret(account.apiKeyEncrypted),
      apiSecret: decryptSecret(account.apiSecretEncrypted),
    };

    const [balances, positions] = await Promise.all([
      getWalletBalances(baseUrl, creds),
      getPositions(baseUrl, creds).catch(() => []),
    ]);

    // Delta's exact field names for wallet balances aren't fully pinned down
    // in this project (see deltaClient.ts) — read defensively across the
    // couple of shapes their API has been observed to return, rather than
    // assuming one and silently showing $0 if it doesn't match.
    const symbolOf = (b: any) => b.asset_symbol || b.asset?.symbol || b.symbol;
    const balanceOf = (b: any) => parseFloat(b.balance ?? b.available_balance ?? b.wallet_balance ?? '0');
    const marginOf = (b: any) => parseFloat(b.blocked_margin ?? b.margin ?? '0');

    const usdBalance =
      balances.find((b: any) => ['USD', 'USDT'].includes(symbolOf(b))) || balances[0];
    const unrealizedPnl = positions.reduce((sum: number, p: any) => sum + parseFloat(p.unrealized_pnl || '0'), 0);

    res.json({
      balance: usdBalance ? balanceOf(usdBalance) : 0,
      unrealizedPnl,
      margin: usdBalance ? marginOf(usdBalance) : 0,
      marginLevel: 0,
      leverage: 10,
      currency: usdBalance ? symbolOf(usdBalance) : 'USD',
    });
  })
);

// POST /accounts/:id/deposit
// There is no API-based faucet for Delta's testnet — test funds are
// credited by Delta when the testnet account is created, and topped up
// manually on https://testnet.delta.exchange if needed. This endpoint
// exists to give the frontend a clear, actionable message instead of a
// generic 404 if the "Deposit" button is used on a demo account.
accountsRouter.post(
  '/:id/deposit',
  requireOwnedAccount,
  asyncHandler(async (req, res) => {
    const account = (req as any).account;
    if (account.type === 'demo') {
      throw new ApiError(
        400,
        'Delta Exchange testnet balances are topped up on testnet.delta.exchange directly, not through this app.'
      );
    }
    throw new ApiError(
      400,
      'Deposits to your real Delta Exchange India account are made directly on delta.exchange / the Delta app, not through this app.'
    );
  })
);
