import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readBytes, writeBytesAtomic } from './codex.js';

export const MAX_AGE = 24 * 60 * 60 * 1000;
const pending = new Map();
const ERROR_CODE = /^[a-z][a-z0-9_]{0,31}$/;

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new TypeError('Invalid quota cache identity');
}

function cacheId(identity, namespace, cacheKey) {
  const source = typeof cacheKey === 'string' ? cacheKey : canonical({ namespace, identity });
  return createHash('sha256').update(source).digest('hex');
}

function safeErrorCode(value) {
  return typeof value === 'string' && ERROR_CODE.test(value) ? value : 'error';
}

function defaultErrorCode(error) {
  if (error?.statusCode === 401) return 'expired';
  if (error?.statusCode === 403) return 'unauthorized';
  if (error?.statusCode === 429) return 'rate_limited';
  return 'error';
}

export function retryUntil(retryAfter, now = Date.now()) {
  const text = typeof retryAfter === 'string' ? retryAfter.trim() : '';
  const delay = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  const bounded = Number.isFinite(delay) ? Math.min(MAX_AGE, Math.max(60_000, delay)) : 300_000;
  return now + bounded;
}

function normalizeUsage(value, normalize) {
  if (value == null) return null;
  const result = normalize(structuredClone(value));
  if (result == null) throw new Error('Empty quota snapshot');
  return structuredClone(result);
}

function readEntry(value, now, normalize) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || !Number.isFinite(value.attemptedAt) || value.attemptedAt < 0 || value.attemptedAt > now
    || !Number.isFinite(value.until) || value.until < 0 || value.until > now + MAX_AGE
    || (value.errorCode != null && !ERROR_CODE.test(value.errorCode))) return null;
  let usage = null;
  let fetchedAt = null;
  if (Number.isFinite(value.fetchedAt) && value.fetchedAt > 0 && value.fetchedAt <= now
    && now - value.fetchedAt <= MAX_AGE) {
    try {
      const normalized = normalizeUsage(value.usage, normalize);
      if (normalized != null) {
        usage = normalized;
        fetchedAt = value.fetchedAt;
      }
    } catch {}
  }
  return { version: 1, attemptedAt: value.attemptedAt, fetchedAt, until: value.until,
    errorCode: value.errorCode || null, usage };
}

function copyEntry(entry) {
  return structuredClone(entry);
}

export async function queryQuota({ directory, memory = new Map(), namespace = 'quota', identity,
  cacheKey, fetchUsage, normalize = value => value, now = Date.now, blockedUntil = 0,
  classifyError = defaultErrorCode }) {
  if (typeof fetchUsage !== 'function') throw new TypeError('Quota query function is required');
  const id = cacheId(identity, namespace, cacheKey);
  const path = join(resolve(directory), `${id}.json`);
  if (!pending.has(path)) {
    const work = (async () => {
      let cached = readEntry(memory.get(id), now(), normalize);
      try {
        const bytes = await readBytes(path);
        const disk = bytes && readEntry(JSON.parse(bytes), now(), normalize);
        if (disk && (!cached || disk.attemptedAt >= cached.attemptedAt)) cached = disk;
      } catch {}

      const current = now();
      const cooldown = Math.max(Number.isFinite(cached?.until) ? cached.until : 0,
        Number.isFinite(blockedUntil) ? blockedUntil : 0);
      if (cooldown > current) {
        const entry = { version: 1, attemptedAt: cached?.attemptedAt ?? current,
          fetchedAt: cached?.fetchedAt || null, usage: cached?.usage || null,
          until: cooldown, errorCode: 'rate_limited' };
        memory.set(id, entry);
        try { await writeBytesAtomic(path, Buffer.from(JSON.stringify(entry))); } catch {}
        return entry;
      }

      let entry;
      try {
        const usage = normalizeUsage(await fetchUsage(), normalize);
        const fetchedAt = now();
        entry = { version: 1, attemptedAt: fetchedAt, fetchedAt, until: 0, errorCode: null, usage };
      } catch (error) {
        const attemptedAt = now();
        let errorCode;
        try {
          const classified = classifyError(error);
          errorCode = safeErrorCode(classified || defaultErrorCode(error));
        } catch { errorCode = defaultErrorCode(error); }
        entry = { version: 1, attemptedAt, fetchedAt: cached?.fetchedAt || null,
          usage: cached?.usage || null,
          until: errorCode === 'rate_limited' ? retryUntil(error?.retryAfter, attemptedAt) : 0,
          errorCode };
      }
      memory.set(id, entry);
      try { await writeBytesAtomic(path, Buffer.from(JSON.stringify(entry))); } catch {}
      return entry;
    })();
    pending.set(path, work);
    void work.finally(() => { if (pending.get(path) === work) pending.delete(path); }).catch(() => {});
  }
  const entry = copyEntry(await pending.get(path));
  memory.set(id, copyEntry(entry));
  return entry;
}
