import { randomBytes } from 'node:crypto';

export function slugifyCapture(input, fallback = 'note') {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || fallback;
}

export function formatUtcTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, '').replace('T', 'T');
}

export function createUniqueSuffix() {
  return randomBytes(4).toString('hex');
}

export function createCaptureFileName(input, options = {}) {
  const now = options.now || new Date();
  const uniqueSuffix = options.uniqueSuffix || createUniqueSuffix();
  return `${formatUtcTimestamp(now)}-${slugifyCapture(input)}-${uniqueSuffix}.md`;
}

export function resolveCapturedBy(explicitValue, env = process.env, fallback = 'unknown') {
  const explicit = String(explicitValue || '').trim();
  if (explicit) return explicit;

  return env.MOLE_CAPTURED_BY?.trim() || env.USER?.trim() || env.USERNAME?.trim() || fallback;
}
