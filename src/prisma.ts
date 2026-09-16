import { PrismaClient } from '@prisma/client';

// Reuse a single PrismaClient instance across hot reloads / requests.
export const prisma = new PrismaClient();
