/**
 * Minimal structured logger — no external dependency needed for Render's
 * log viewer (which already timestamps every line). Keeps a consistent
 * [level] tag so logs are easy to grep/filter in the Render dashboard.
 */

function timestamp() {
  return new Date().toISOString();
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => {
    console.log(`[info] ${timestamp()} ${message}`, meta ? JSON.stringify(meta) : '');
  },
  warn: (message: string, meta?: Record<string, unknown>) => {
    console.warn(`[warn] ${timestamp()} ${message}`, meta ? JSON.stringify(meta) : '');
  },
  error: (message: string, err?: unknown) => {
    const detail = err instanceof Error ? err.message : err;
    console.error(`[error] ${timestamp()} ${message}`, detail ?? '');
  },
};
