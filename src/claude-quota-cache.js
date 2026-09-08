import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readBytes, writeBytesAtomic } from './codex.js';

const MAX_AGE = 24 * 60 * 60 * 1000;
const pending = new Map();
const errors = new Set(['expired', 'unauthorized', 'rate_limited', 'error']);

function cleanUsage(usage) {
  const window = value => {
    if (value == null) return null;
    if (typeof value.percent_remaining !== 'number' || !Number.isFinite(value.percent_remaining)
      || value.percent_remaining < 0 || value.percent_remaining > 100) throw new Error('Invalid cached quota');
    return {
      label: typeof value.label === 'string' ? value.label.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 40) : '',
      percent_remaining: value.percent_remaining,
      reset_time_iso: typeof value.reset_time_iso === 'string' && Number.isFinite(Date.parse(value.reset_time_iso))
        ? new Date(value.reset_time_iso).toISOString() : null,
    };
  };
  if (!usage || !Array.isArray(usage.extra_windows) || usage.extra_windows.length > 32) throw new Error('Invalid cached quota');
  const result = { daily: window(usage.daily), weekly: window(usage.weekly), extra_windows: usage.extra_windows.map(window).filter(Boolean) };
  if (!result.daily && !result.weekly && !result.extra_windows.length) throw new Error('Empty cached quota');
  return result;
}

function readEntry(value, now) {
  if (value?.version !== 1 || !Number.isFinite(value.attemptedAt) || value.attemptedAt > now
    || !Number.isFinite(value.until) || value.until < 0 || (value.errorCode != null && !errors.has(value.errorCode))) return null;
  let usage = null;
  if (Number.isFinite(value.fetchedAt) && value.fetchedAt > 0 && value.fetchedAt <= now && now - value.fetchedAt <= MAX_AGE) {
    try { usage = cleanUsage(value.usage); } catch {}
  }
  return { version: 1, attemptedAt: value.attemptedAt, until: value.until, errorCode: value.errorCode,
    fetchedAt: usage ? value.fetchedAt : null, usage };
}

export function claudeRetryUntil(retryAfter, now) {
  const text = typeof retryAfter === 'string' ? retryAfter.trim() : '';
  const delay = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return now + Math.max(60_000, Number.isFinite(delay) ? delay : 300_000);
}

// Request first; only failures/cooldown fall back to a token-bound last success.
// Disk contains normalized usage and timings, never credentials or provider error bodies.
export async function queryClaudeQuota({ token, directory, memory, fetchUsage, now = Date.now, blockedUntil = 0 }) {
  const id = createHash('sha256').update(token).digest('hex');
  const path = join(resolve(directory), `${id}.json`);
  if (!pending.has(path)) {
    const work = (async () => {
      let cached = readEntry(memory.get(id), now());
      try {
        const bytes = await readBytes(path);
        const disk = bytes && readEntry(JSON.parse(bytes), now());
        if (disk && (!cached || disk.attemptedAt >= cached.attemptedAt)) cached = disk;
      } catch { /* A bad/unavailable cache never prevents a live usage request. */ }
      if (cached?.until > now() || blockedUntil > now()) {
        const entry = { version: 1, attemptedAt: cached?.attemptedAt ?? now(),
          fetchedAt: cached?.fetchedAt || null, usage: cached?.usage || null,
          until: Math.max(cached?.until || 0, blockedUntil), errorCode: 'rate_limited' };
        memory.set(id, entry);
        return entry;
      }
      let entry;
      try {
        const usage = cleanUsage(await fetchUsage());
        // Defensive redaction if an upstream model label happens to echo the credential.
        for (const window of [usage.daily, usage.weekly, ...usage.extra_windows]) {
          if (window) window.label = window.label.split(token).join('[redacted]');
        }
        entry = { version: 1, attemptedAt: now(), fetchedAt: now(), until: 0, errorCode: null, usage };
      } catch (error) {
        const status = error?.statusCode;
        entry = { version: 1, attemptedAt: now(), fetchedAt: cached?.fetchedAt || null,
          usage: cached?.usage || null,
          until: status === 429 ? claudeRetryUntil(error.retryAfter, now()) : 0,
          errorCode: status === 401 ? 'expired' : status === 403 ? 'unauthorized' : status === 429 ? 'rate_limited' : 'error' };
      }
      memory.set(id, entry);
      try { await writeBytesAtomic(path, Buffer.from(JSON.stringify(entry))); } catch { /* Retain the in-memory fallback. */ }
      return entry;
    })();
    pending.set(path, work);
    void work.finally(() => { if (pending.get(path) === work) pending.delete(path); }).catch(() => {});
  }
  const entry = structuredClone(await pending.get(path));
  memory.set(id, structuredClone(entry));
  return entry;
}
