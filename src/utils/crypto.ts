import crypto from 'crypto';
import { env } from '../env';

const ALGORITHM = 'aes-256-gcm';
const key = Buffer.from(env.encryptionKey, 'hex'); // must be 32 bytes (64 hex chars)

if (key.length !== 32) {
  throw new Error(
    'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ' +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
  );
}

/**
 * Encrypts a plaintext string (e.g. a Delta Exchange API secret) for storage.
 * Returns "iv:authTag:ciphertext" as a single hex-encoded string.
 */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a string produced by encryptSecret(). Only ever call this
 * server-side, immediately before signing a request to Delta Exchange —
 * never return the decrypted value to the frontend.
 */
export function decryptSecret(payload: string): string {
  const [ivHex, authTagHex, dataHex] = payload.split(':');
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error('Malformed encrypted payload.');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
