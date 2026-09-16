import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../prisma';
import { asyncHandler, ApiError } from '../utils/asyncHandler';
import { requireAuth } from '../middleware/auth';

export const usersRouter = Router();
usersRouter.use(requireAuth);

const updateSchema = z.object({
  language: z.string().optional(),
  oneClickTrading: z.boolean().optional(),
  name: z.string().optional(),
});

// PATCH /users/me
usersRouter.patch(
  '/me',
  asyncHandler(async (req, res) => {
    const data = updateSchema.parse(req.body);
    const user = await prisma.user.update({ where: { id: req.userId }, data });
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      settings: { language: user.language, oneClickTrading: user.oneClickTrading },
    });
  })
);

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

// PATCH /users/me/password
usersRouter.patch(
  '/me/password',
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = passwordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) throw new ApiError(404, 'User not found.');

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) throw new ApiError(401, 'Current password is incorrect.');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    res.json({ success: true });
  })
);
