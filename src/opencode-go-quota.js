import https from 'node:https';
import { createHash } from 'node:crypto';
import { t } from './i18n.js';
import { queryQuota } from './quota-cache.js';

export function parseGoUsage(data) {
  if (data && typeof data === 'object' && !Array.isArray(data) && !data.usage && data.daily) {
    const clean = value => {
      if (value == null || typeof value !== 'object' || typeof value.percent_remaining !== 'number'
        || !Number.isFinite(value.percent_remaining) || value.percent_remaining < 0 || value.percent_remaining > 100
        || (value.reset_time_iso != null && (typeof value.reset_time_iso !== 'string' || !Number.isFinite(Date.parse(value.reset_time_iso))))) {
        throw new Error('Invalid cached Go usage');
      }
      return { percent_remaining: value.percent_remaining,
        reset_time_iso: value.reset_time_iso ? new Date(value.reset_time_iso).toISOString() : null };
    };
    const daily = clean(data.daily);
    const weekly = data.weekly == null ? null : clean(data.weekly);
    const monthly = data.monthly_percent;
    if (typeof monthly !== 'number' || !Number.isFinite(monthly) || monthly < 0 || monthly > 100
      || (data.monthly_reset_iso != null && (typeof data.monthly_reset_iso !== 'string'
        || !Number.isFinite(Date.parse(data.monthly_reset_iso))))) throw new Error('Invalid cached Go usage');
    return { daily, weekly, monthly_percent: monthly,
      monthly_reset_iso: data.monthly_reset_iso ? new Date(data.monthly_reset_iso).toISOString() : null };
  }
  const window = name => {
    const row = data?.usage?.[name];
    if (!row || !['ok', 'rate-limited'].includes(row.status)
      || typeof row.percent !== 'number' || !Number.isFinite(row.percent) || row.percent < 0
      || typeof row.resetsAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(row.resetsAt)
      || !Number.isFinite(Date.parse(row.resetsAt))) throw new Error('Invalid Go usage');
    return { percent_remaining: Math.round(Math.max(0, 100 - row.percent)),
      reset_time_iso: new Date(row.resetsAt).toISOString() };
  };
  const daily = window('rolling'), weekly = window('weekly'), monthly = window('monthly');
  return { daily, weekly, monthly_percent: monthly.percent_remaining, monthly_reset_iso: monthly.reset_time_iso };
}

function requestUsage(key) {
  return new Promise((resolve, reject) => {
    const request = https.request('https://opencode.ai/zen/go/v1/usage', {
      method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      timeout: 10000, signal: AbortSignal.timeout(10000),
    }, response => {
      response.on('error', () => reject(new Error('Go response failed')));
      response.on('aborted', () => reject(new Error('Go response aborted')));
      if (response.statusCode !== 200) {
        reject({ statusCode: response.statusCode, retryAfter: response.headers['retry-after'] });
        response.destroy(); return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) { reject(new Error('Go response too large')); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Invalid Go response')); }
      });
    });
    request.on('error', () => reject(new Error('Go request failed')));
    request.on('timeout', () => { reject(new Error('Go timeout')); request.destroy(); });
    request.end();
  });
}

const errorKey = code => code === 'expired' || code === 'unauthorized' ? 'quota_go_auth'
  : code === 'entitlement' ? 'quota_go_entitlement'
    : code === 'rate_limited' ? 'quota_go_rate_limited' : 'quota_go_failed';

export class GoQuota {
  constructor({ request = requestUsage, now = Date.now, directory = null, memory = new Map() } = {}) {
    this.request = request; this.now = now; this.directory = directory; this.memory = memory;
    this.cooldown = new Map(); this.pending = new Map();
  }

  async collect(key) {
    const base = { provider: 'opencodego', account_id: 'OpenCode Go', presets: ['(Current Active)'],
      daily: null, weekly: null, monthly_percent: null, monthly_reset_iso: null };
    if (typeof key !== 'string' || !key || /[\s\x00-\x1f\x7f-\x9f]/.test(key)) return [{ ...base, error: t('quota_go_auth') }];
    const id = createHash('sha256').update(key).digest('hex');
    if (!this.directory) return this.#collectMemoryOnly(key, id, base);

    const snapshot = await queryQuota({
      directory: this.directory,
      memory: this.memory,
      namespace: 'opencode-go-api-v1',
      identity: { provider: 'opencodego', mode: 'api-key', endpoint: 'https://opencode.ai/zen/go/v1/usage', schema: 1, credential: key },
      blockedUntil: this.cooldown.get(id) || 0,
      now: this.now,
      fetchUsage: () => this.request(key),
      normalize: parseGoUsage,
      classifyError: error => error?.statusCode === 403 ? 'entitlement' : undefined,
    });
    if (snapshot.until > this.now()) this.cooldown.set(id, snapshot.until);
    if (!snapshot.usage) return [{ ...base, error: t(errorKey(snapshot.errorCode)) }];
    return [{ ...base, ...snapshot.usage, error: null,
      ...(snapshot.errorCode ? { cached: true, cached_at: new Date(snapshot.fetchedAt).toISOString(), cache_error: snapshot.errorCode } : {}) }];
  }

  async #collectMemoryOnly(key, id, base) {
    if (this.pending.has(id)) return structuredClone(await this.pending.get(id));
    const pending = (async () => {
      if ((this.cooldown.get(id) || 0) > this.now()) return [{ ...base, error: t('quota_go_rate_limited') }];
      try { return [{ ...base, ...parseGoUsage(await this.request(key)), error: null }]; }
      catch (error) {
        const status = error?.statusCode;
        if (status === 429) {
          const retry = error.retryAfter;
          const text = typeof retry === 'string' ? retry.trim() : '';
          const delay = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - this.now();
          for (const [key, until] of this.cooldown) if (until <= this.now()) this.cooldown.delete(key);
          this.cooldown.set(id, this.now() + Math.max(60000, Number.isFinite(delay) ? delay : 300000));
        }
        return [{ ...base, error: t(status === 401 ? 'quota_go_auth' : status === 403 ? 'quota_go_entitlement'
          : status === 429 ? 'quota_go_rate_limited' : 'quota_go_failed') }];
      }
    })();
    this.pending.set(id, pending);
    try { return await pending; } finally { this.pending.delete(id); }
  }
}
