import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { safePath, tokenClaims } from './codex.js';
import { getClaudeCodeCredentialsPath, parseClaudeUsage } from './core.js';
import { queryClaudeQuota } from './claude-quota-cache.js';
import { queryQuota } from './quota-cache.js';

const MAX_BYTES = 1024 * 1024;
const text = value => typeof value === 'string' && value.length > 0
  && Array.from(value).every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127);

function requestJson(url, options, timeout) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { ...options, timeout }, response => {
      response.on('error', () => reject(0));
      response.on('aborted', () => reject(0));
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject({ statusCode: response.statusCode, retryAfter: response.headers['retry-after'] });
        response.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) { reject(0); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(0); }
      });
    });
    request.on('error', () => reject(0));
    request.on('timeout', () => { reject(0); request.destroy(); });
    request.end();
  });
}

async function readCredentials(path) {
  await safePath(path);
  let file;
  try {
    file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw 0;
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw 0;
    const content = bytes.subarray(0, size);
    const auth = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content));
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw 0;
    return { auth, fingerprint: createHash('sha256').update(path).update(content).digest('hex') };
  } finally {
    await file?.close();
  }
}

function resetAt(window, now) {
  for (const value of [window?.reset_at, window?.resets_at]) {
    const milliseconds = typeof value === 'number' && Number.isFinite(value)
      ? value < 1e12 ? value * 1000 : value
      : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
    if (milliseconds > 0 && Number.isFinite(new Date(milliseconds).getTime())) return milliseconds;
  }
  const seconds = window?.reset_after_seconds;
  const milliseconds = now + seconds * 1000;
  return typeof seconds === 'number' && seconds >= 0 && Number.isFinite(new Date(milliseconds).getTime())
    ? milliseconds : null;
}

function cleanCodexWindow(value) {
  if (value == null) return null;
  if (typeof value.percent_remaining !== 'number' || !Number.isFinite(value.percent_remaining)
    || value.percent_remaining < 0 || value.percent_remaining > 100) throw new Error('Invalid Codex usage');
  return { percent_remaining: value.percent_remaining,
    reset_time_iso: typeof value.reset_time_iso === 'string' && Number.isFinite(Date.parse(value.reset_time_iso))
      ? new Date(value.reset_time_iso).toISOString() : null };
}

function normalizeCodexUsage(data, now) {
  if (data?.rate_limit && typeof data.rate_limit === 'object') {
    const { primary_window: primary, secondary_window: secondary } = data.rate_limit;
    const valid = value => typeof value?.used_percent === 'number' && Number.isFinite(value.used_percent);
    const selected = [primary, secondary].find(value => valid(value) && value.limit_window_seconds === 18_000)
      || (valid(primary) ? primary : null);
    if (!selected) throw new Error('Invalid Codex usage');
    const remaining = value => Math.round(Math.max(0, Math.min(100, 100 - value.used_percent)));
    const window = new Map([[18_000, '5h'], [86_400, '24h'], [604_800, '7d']]).get(selected.limit_window_seconds) || 'quota';
    return {
      daily: { percent_remaining: remaining(selected), reset_time_iso: (() => {
        const value = resetAt(selected, now);
        return value == null ? null : new Date(value).toISOString();
      })() },
      weekly: valid(secondary) ? { percent_remaining: remaining(secondary), reset_time_iso: (() => {
        const value = resetAt(secondary, now);
        return value == null ? null : new Date(value).toISOString();
      })() } : null,
      window,
    };
  }
  const daily = cleanCodexWindow(data?.daily);
  const weekly = cleanCodexWindow(data?.weekly);
  if (!daily) throw new Error('Invalid Codex usage');
  return { daily, weekly, window: ['5h', '24h', '7d', 'quota'].includes(data.window) ? data.window : 'quota' };
}

export class ActiveQuotaCollector {
  #cooldown = new Map();
  #pending = new Map();
  #claudeCache = new Map();
  #codexCache = new Map();

  constructor({ homeDir = homedir(), configDir = join(homeDir, '.config', 'oauth-preset-manager'),
    requestJson: request = requestJson, now = Date.now } = {}) {
    this.homeDir = homeDir;
    this.configDir = resolve(configDir);
    this._requestJson = request;
    this.now = now;
  }

  async collect({ force = false, providers = ['codex', 'claude'] } = {}) {
    if (!Array.isArray(providers) || providers.some(provider => !['codex', 'claude'].includes(provider))) throw new Error('Invalid provider selection');
    return Promise.all([...new Set(providers)].map(provider => {
      const pending = (this.#pending.get(provider) || Promise.resolve()).then(() => this.#collect(provider, force));
      this.#pending.set(provider, pending.then(() => {}, () => {}));
      return pending;
    }));
  }

  async #collect(provider) {
    const result = (status, percent = null) => ({ provider, percent, status });
    let credentials;
    try {
      const path = provider === 'codex'
        ? join(process.env.CODEX_HOME?.trim() || join(this.homeDir, '.codex'), 'auth.json')
        : getClaudeCodeCredentialsPath(this.homeDir);
      credentials = await readCredentials(resolve(path));
    } catch (error) {
      return result(error?.code === 'ENOENT' ? 'missing' : 'error');
    }
    const { auth } = credentials;
    const entry = provider === 'codex' ? auth.tokens : auth.claudeAiOauth;
    const token = provider === 'codex' ? entry?.access_token : entry?.accessToken;
    if ((provider === 'codex' && ((auth.auth_mode != null && auth.auth_mode !== 'chatgpt')
      || auth.OPENAI_API_KEY != null)) || !text(token) || token.startsWith('sk-ant-api')
      || (provider === 'codex' && token.startsWith('sk-'))) return result('missing');

    const exp = tokenClaims(token)?.exp;
    const expires = provider === 'claude' ? entry?.expiresAt : null;
    const expiries = [exp == null ? null : (typeof exp === 'number' ? exp * 1000 : NaN), expires];
    if (expiries.some(value => value != null && (typeof value !== 'number' || !Number.isFinite(value)))) return result('error');
    const expired = expiries.some(value => value != null && value <= this.now());
    if (provider === 'claude' && entry.scopes != null
      && (!Array.isArray(entry.scopes) || !entry.scopes.includes('user:profile'))) return result('unauthorized');
    if (provider === 'codex' && entry.account_id != null && !text(entry.account_id)) return result('error');

    if (provider === 'claude') {
      const snapshot = await queryClaudeQuota({ token, now: this.now, memory: this.#claudeCache,
        directory: join(this.configDir, 'claude-quota-cache'),
        blockedUntil: this.#cooldown.get(provider) || 0,
        fetchUsage: expired ? async () => { throw { statusCode: 401 }; } : async () => parseClaudeUsage(await this._requestJson('https://api.anthropic.com/api/oauth/usage', {
          method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
          signal: AbortSignal.timeout(10_000),
        }, 10_000)),
        classifyError: error => error?.statusCode === 401 ? (expired ? 'expired' : 'unauthorized') : undefined,
      });
      if (snapshot.until > this.now()) this.#cooldown.set(provider, snapshot.until);
      const daily = snapshot.usage?.daily;
      if (!Number.isFinite(daily?.percent_remaining)) return result(snapshot.errorCode || 'error');
      const milliseconds = Date.parse(daily.reset_time_iso);
      return { ...result(snapshot.errorCode ? 'cached' : 'ok', daily.percent_remaining), window: '5h',
        resetAt: Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null,
        ...(snapshot.errorCode ? { cachedAt: snapshot.fetchedAt, cacheError: snapshot.errorCode } : {}) };
    }

    const accountId = entry.account_id || null;
    const snapshot = await queryQuota({
      directory: join(this.configDir, 'codex-quota-cache'),
      memory: this.#codexCache,
      namespace: 'codex-wham-usage-v1',
      identity: { provider: 'codex', endpoint: 'https://chatgpt.com/backend-api/wham/usage', schema: 1,
        credential: token, account_id: accountId },
      blockedUntil: this.#cooldown.get(provider) || 0,
      now: this.now,
      fetchUsage: expired ? async () => { throw { statusCode: 401 }; } : async () => {
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        if (accountId) headers['ChatGPT-Account-Id'] = accountId;
        return this._requestJson('https://chatgpt.com/backend-api/wham/usage',
          { method: 'GET', headers, signal: AbortSignal.timeout(10_000) }, 10_000);
      },
      normalize: value => normalizeCodexUsage(value, this.now()),
      classifyError: error => error?.statusCode === 401 ? (expired ? 'expired' : 'unauthorized') : undefined,
    });
    if (snapshot.until > this.now()) this.#cooldown.set(provider, snapshot.until);
    const daily = snapshot.usage?.daily;
    if (!Number.isFinite(daily?.percent_remaining)) return result(snapshot.errorCode || 'error');
    const milliseconds = Date.parse(daily.reset_time_iso);
    return { ...result(snapshot.errorCode ? 'cached' : 'ok', daily.percent_remaining),
      window: snapshot.usage.window, resetAt: Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null,
      ...(snapshot.errorCode ? { cachedAt: snapshot.fetchedAt, cacheError: snapshot.errorCode } : {}) };
  }
}
