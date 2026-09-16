import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  // Frontend's dev server is hard-coded to port 3000 (frontend/package.json's
  // "dev" script) — default to a different port so `npm run dev` in both
  // folders at once doesn't fight over the same port.
  port: parseInt(process.env.PORT || '4000', 10),

  databaseUrl: required('DATABASE_URL'),

  jwtSecret: required('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  // 32-byte hex string (64 hex chars) used for AES-256-GCM encryption of
  // exchange API keys/secrets at rest. Generate with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  encryptionKey: required('ENCRYPTION_KEY'),

  // Comma-separated list of allowed frontend origins for CORS.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map(s => s.trim()),

  deltaApiBaseUrl: process.env.DELTA_API_BASE_URL || 'https://api.india.delta.exchange',
  deltaTestnetBaseUrl: process.env.DELTA_TESTNET_BASE_URL || 'https://cdn-ind.testnet.deltaex.org',
};
