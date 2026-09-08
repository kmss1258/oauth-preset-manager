import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import https from 'node:https';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { safePath, tokenClaims } from './codex.js';
import { getClaudeCodeCredentialsPath, parseClaudeUsage } from './core.js';

const MAX_BYTES = 1024 * 1024;
const text = value => typeof value === 'string' && value.length > 0
  && Array.from(value).every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127);

function requestJson(url, options, timeout) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { ...options, timeout }, response => {
      response.on('error', () => reject(0));
      response.on('aborted', () => reject(0));
      // Preserve cooldown even if an error body stalls or disconnects; never retain it.
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
    // Bound the read as well as the stat check in case the file grows while open.
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

// Percent means quota remaining. No window label or account metadata is exposed.
export class ActiveQuotaCollector {
  #cache = new Map();
  #cooldown = new Map();
  #pending = new Map();

  constructor({ homeDir = homedir(), requestJson: request = requestJson, now = Date.now } = {}) {
    this.homeDir = homeDir;
    this._requestJson = request;
    this.now = now;
  }

  async collect() {
    return Promise.all(['codex', 'claude'].map(provider => {
      // Serialize each provider, not both: overlapping polls still reread credentials.
      const pending = (this.#pending.get(provider) || Promise.resolve()).then(() => this.#collect(provider));
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
      this.#cache.delete(provider);
      return result(error?.code === 'ENOENT' ? 'missing' : 'error');
    }
    const { auth, fingerprint } = credentials;
    if (this.#cache.get(provider)?.fingerprint !== fingerprint) this.#cache.delete(provider);
    const entry = provider === 'codex' ? auth.tokens : auth.claudeAiOauth;
    const token = provider === 'codex' ? entry?.access_token : entry?.accessToken;
    if ((provider === 'codex' && ((auth.auth_mode != null && auth.auth_mode !== 'chatgpt')
      || auth.OPENAI_API_KEY != null)) || !text(token) || token.startsWith('sk-ant-api')
      || (provider === 'codex' && token.startsWith('sk-'))) {
      this.#cache.delete(provider);
      return result('missing');
    }
    const exp = tokenClaims(token)?.exp;
    const expires = provider === 'claude' ? entry.expiresAt : null;
    const expiries = [exp == null ? null : (typeof exp === 'number' ? exp * 1000 : NaN), expires];
    if (expiries.some(value => value != null && (typeof value !== 'number' || !Number.isFinite(value)))) return result('error');
    if (expiries.some(value => value != null && value <= this.now())) return result('expired');
    if (provider === 'claude' && entry.scopes != null
      && (!Array.isArray(entry.scopes) || !entry.scopes.includes('user:profile'))) return result('unauthorized');
    if (provider === 'codex' && entry.account_id != null && !text(entry.account_id)) return result('error');
    if ((this.#cooldown.get(provider) || 0) > this.now()) return result('rate_limited');
    const cached = this.#cache.get(provider);
    if (cached?.until > this.now()) return { ...cached.result };
    this.#cache.delete(provider);
    try {
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (provider === 'codex' && entry.account_id) headers['ChatGPT-Account-Id'] = entry.account_id;
      if (provider === 'claude') headers['anthropic-beta'] = 'oauth-2025-04-20';
      const data = await this._requestJson(provider === 'codex'
        ? 'https://chatgpt.com/backend-api/wham/usage' : 'https://api.anthropic.com/api/oauth/usage',
      { method: 'GET', headers, signal: AbortSignal.timeout(10_000) }, 10_000);
      let percent;
      if (provider === 'codex') {
        const { primary_window: primary, secondary_window: secondary } = data?.rate_limit || {};
        // Prefer an explicitly identified 5h window. A metadata-free primary is unlabeled.
        const window = [primary, secondary].find(value => value?.limit_window_seconds === 18_000)
          || (primary?.limit_window_seconds == null ? primary : null);
        const used = window?.used_percent;
        if (typeof used !== 'number' || !Number.isFinite(used)) throw 0;
        percent = Math.round(Math.max(0, Math.min(100, 100 - used)));
      } else {
        percent = parseClaudeUsage(data).daily?.percent_remaining;
      }
      if (!Number.isFinite(percent)) throw 0;
      const value = result('ok', percent);
      this.#cache.set(provider, { fingerprint, until: this.now() + 60_000, result: value });
      return { ...value };
    } catch (error) {
      const status = error?.statusCode;
      if (status === 429) {
        const retry = error.retryAfter;
        const delay = typeof retry === 'string' && /^\d+(\.\d+)?$/.test(retry.trim())
          ? Number(retry) * 1000 : typeof retry === 'string' ? Date.parse(retry) - this.now() : NaN;
        this.#cooldown.set(provider, this.now() + Math.max(60_000, Number.isFinite(delay) ? delay : 300_000));
      }
      return result(status === 429 ? 'rate_limited' : status === 401 || status === 403 ? 'unauthorized' : 'error');
    }
  }
}
