import { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../utils/jwt';
import { prisma } from '../prisma';
import { ApiError } from '../utils/asyncHandler';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/** Requires a valid auth cookie (or Authorization: Bearer <token> header) and attaches req.userId. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const cookieToken = req.cookies?.token;
    const headerToken = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : undefined;
    const token = cookieToken || headerToken;
    if (!token) throw new ApiError(401, 'Not authenticated.');

    const payload = verifyToken(token);
    req.userId = payload.userId;
    next();
  } catch (err) {
    next(new ApiError(401, 'Invalid or expired session.'));
  }
}

/**
 * Loads the :id / :accountId route param as an ExchangeAccount and confirms
 * it belongs to the authenticated user. Attaches it as req.account.
 */
export async function requireOwnedAccount(req: Request, _res: Response, next: NextFunction) {
  try {
    const accountId = req.params.id || req.params.accountId;
    const account = await prisma.exchangeAccount.findFirst({
      where: { id: accountId, userId: req.userId },
    });
    if (!account) throw new ApiError(404, 'Account not found.');
    (req as any).account = account;
    next();
  } catch (err) {
    next(err);
  }
}
