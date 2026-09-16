import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';
import { encryptSecret } from '../utils/crypto';
import { getWalletBalances, getBaseUrl } from '../services/deltaClient';

export const exchangeRouter = Router();
exchangeRouter.use(requireAuth);

const connectSchema = z.object({
  apiKey: z.string().min(10),
  apiSecret: z.string().min(10),
  label: z.string().min(1).optional(),
  // "demo"  -> verified & traded against Delta's testnet (paper money)
  // "real"  -> verified & traded against Delta's production API (real money)
  mode: z.enum(['demo', 'real']),
});

// POST /exchange/connect
// The frontend's "Connect a trading account" flow calls this for BOTH the
// paper-trading (testnet) and live account cases — same shape, different
// `mode`, and different keys (a Delta testnet key will not work against
// production and vice versa).
exchangeRouter.post(
  '/connect',
  asyncHandler(async (req, res) => {
    const { apiKey, apiSecret, label, mode } = connectSchema.parse(req.body);
    const baseUrl = getBaseUrl(mode);

    // Verify the credentials actually work before saving them.
    try {
      await getWalletBalances(baseUrl, { apiKey, apiSecret });
    } catch (err: any) {
      const where = mode === 'demo' ? 'Delta Exchange testnet' : 'Delta Exchange India';
      throw new ApiError(400, `Could not verify credentials against ${where}: ${err.message}`);
    }

    const account = await prisma.exchangeAccount.create({
      data: {
        userId: req.userId!,
        label: label || (mode === 'demo' ? 'Demo Account (Testnet)' : 'Delta Exchange Account'),
        type: mode,
        apiKeyEncrypted: encryptSecret(apiKey),
        apiSecretEncrypted: encryptSecret(apiSecret),
      },
    });

    res.json({ accountId: account.id, status: 'connected', type: account.type });
  })
);

// GET /exchange/accounts
exchangeRouter.get(
  '/accounts',
  asyncHandler(async (req, res) => {
    const accounts = await prisma.exchangeAccount.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
    });
    res.json(
      accounts.map(a => ({
        id: a.id,
        label: a.label,
        type: a.type,
        createdAt: a.createdAt,
      }))
    );
  })
);

// DELETE /exchange/accounts/:id
exchangeRouter.delete(
  '/accounts/:id',
  asyncHandler(async (req, res) => {
    const account = await prisma.exchangeAccount.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!account) throw new ApiError(404, 'Account not found.');

    await prisma.exchangeAccount.delete({ where: { id: account.id } });
    res.json({ success: true });
  })
);
