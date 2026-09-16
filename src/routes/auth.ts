import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../prisma';
import { signToken } from '../utils/jwt';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';

export const authRouter = Router();

// The frontend runs on a different domain than this API (e.g. an AI Studio
// / Cloud Run URL vs a Render URL), so the auth cookie must be
// SameSite=None + Secure to survive cross-site requests. The frontend also
// sends the token as an `Authorization: Bearer` header as a fallback (see
// middleware/auth.ts) in case a browser or embedded webview blocks
// third-party cookies entirely.
const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'none' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const signupSchema = z.object({
  email: z.string().email().transform(e => e.trim().toLowerCase()),
  password: z.string().min(8, 'Password must be at least 8 characters.'),
  name: z.string().trim().optional(),
});

function publicUser(user: { id: string; email: string; name: string | null; language: string; oneClickTrading: boolean }) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    settings: { language: user.language, oneClickTrading: user.oneClickTrading },
  };
}

// POST /auth/signup
authRouter.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const { email, password, name } = signupSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new ApiError(409, 'An account with this email already exists.');

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({ data: { email, passwordHash, name } });

    // No account is auto-created anymore — both "Demo" (Delta testnet) and
    // "Real" (Delta production) accounts require the user to paste an API
    // key/secret via POST /exchange/connect, matching the "Connect a
    // trading account" step in the Accounts page checklist.

    const token = signToken({ userId: user.id });
    res.cookie('token', token, cookieOptions);
    res.json({ user: publicUser(user), token });
  })
);

const loginSchema = z.object({
  email: z.string().email().transform(e => e.trim().toLowerCase()),
  password: z.string().min(1),
});

// POST /auth/login
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new ApiError(401, 'Invalid email or password.');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) throw new ApiError(401, 'Invalid email or password.');

    const token = signToken({ userId: user.id });
    res.cookie('token', token, cookieOptions);
    res.json({ user: publicUser(user), token });
  })
);

// POST /auth/logout
authRouter.post('/logout', (_req, res) => {
  res.clearCookie('token', cookieOptions);
  res.json({ success: true });
});

// GET /auth/me
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) throw new ApiError(404, 'User not found.');
    res.json(publicUser(user));
  })
);
