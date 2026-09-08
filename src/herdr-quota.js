import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ActiveQuotaCollector } from './active-quota.js';
import { acquireHerdrLock, ensureHerdrQuotaConfig, HERDR_QUOTA_TOKENS } from './herdr-config.js';

const execute = promisify(execFile);
const SOURCE = 'opm:quota';
const POLL_MS = 60_000;
const TICK_MS = 15_000;
const TTL_MS = 45_000;
const idle = () => {};

export function compactReset(resetAt, now = Date.now()) {
  if (!Number.isFinite(resetAt) || resetAt <= 0) return '-';
  const milliseconds = resetAt - now;
  if (milliseconds <= 0) return 'reset';
  const minutes = Math.floor(milliseconds / 60_000);
  if (!minutes) return '<1m';
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `${minutes}m`;
}

export function formatHerdrQuota(row, now = Date.now()) {
  const label = (row.provider === 'codex' ? 'CX' : 'CC') + (row.status === 'cached' ? '*' : '');
  const statuses = { missing: 'login', expired: 'expired', unauthorized: 'auth', rate_limited: '429', loading: '…', error: 'error' };
  if (!['ok', 'cached'].includes(row.status) || !Number.isFinite(row.percent)) return `${label} ${statuses[row.status] || 'error'}`;
  const percent = Math.round(Math.max(0, Math.min(100, row.percent)));
  const filled = Math.round(percent / 25);
  const window = ['7d', '24h', 'quota'].includes(row.window) ? ` ${row.window}` : '';
  return `${label}${window} ${'▰'.repeat(filled)}${'▱'.repeat(4 - filled)} ${percent}% ${compactReset(row.resetAt, now)}`;
}

export function herdrRunner(env = process.env) {
  return async (args, overrides = {}) => {
    const { stdout } = await execute(env.HERDR_BIN_PATH || 'herdr', args, {
      env: { ...env, ...overrides }, timeout: 2000, maxBuffer: 256 * 1024,
      encoding: 'utf8', windowsHide: true,
    });
    return stdout;
  };
}

export function startHerdrQuota({ interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  env = process.env, homeDir = homedir(), run = herdrRunner(env), collector,
  now = Date.now, onWarning = idle, tickMs = TICK_MS, ttlMs = TTL_MS } = {}) {
  if (!interactive || env.HERDR_ENV !== '1' || !env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH) {
    return { ready: Promise.resolve(), refresh: idle, stop: async () => {} };
  }
  return new HerdrQuotaDisplay({ env, homeDir, run, collector: collector || new ActiveQuotaCollector({ homeDir }),
    now, onWarning, tickMs, ttlMs });
}

class HerdrQuotaDisplay {
  constructor(options) {
    Object.assign(this, options);
    this.rows = ['codex', 'claude'].map(provider => ({ provider, status: 'loading' }));
    this.stopped = false;
    this.queue = Promise.resolve();
    this.nextPoll = 0;
    this.ready = this.initialize().catch(() => { this.disabled = true; this.warn(); });
    this.ready.then(() => {
      if (this.stopped || this.disabled) return;
      this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
      this.timer.unref?.();
      this.refresh();
    });
  }

  warn() {
    if (this.warned || this.stopped) return;
    this.warned = true;
    this.onWarning();
  }

  serialize(action) {
    const next = this.queue.then(action);
    this.queue = next.catch(() => { this.warn(); });
    return this.queue;
  }

  async initialize() {
    const socket = resolve(this.env.HERDR_SOCKET_PATH);
    const stat = await fs.stat(socket);
    if (!stat.isSocket()) throw new Error('Not a Herdr socket');
    this.sessionKey = `${socket}:${stat.dev}:${stat.ino}`;
    this.configPath = resolve(this.env.HERDR_CONFIG_PATH || join(this.env.XDG_CONFIG_HOME || join(this.homeDir, '.config'), 'herdr', 'config.toml'));
    await this.syncWorkspace();
    if (!this.stopped && this.unlock) await this.publish();
  }

  async syncWorkspace() {
    const current = JSON.parse(await this.run(['pane', 'current', '--current']));
    const workspace = current.result?.pane?.workspace_id;
    if (typeof workspace !== 'string' || !/^[a-zA-Z0-9:_-]+$/.test(workspace)) throw new Error('No calling workspace');
    if (this.stopped) return;
    if (this.workspace !== workspace) {
      await this.release();
      this.workspace = workspace;
    }
    if (this.unlock) return;
    const key = createHash('sha256').update(`${this.sessionKey}:${workspace}`).digest('hex');
    const lockPath = join(this.homeDir, '.config', 'oauth-preset-manager', 'herdr-quota', `${key}.lock`);
    this.unlock = await acquireHerdrLock(lockPath);
    if (!this.unlock) return;
    try {
      if (!this.configured) {
        // Another Space may be installing the same rows. Retry only this short setup transaction.
        for (let attempt = 0; ; attempt++) {
          try { await ensureHerdrQuotaConfig(this.configPath, this.run); break; }
          catch (error) {
            if (error.message !== 'Herdr configuration is busy' || attempt >= 9) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        this.configured = true;
      }
    } catch (error) { await this.unlock(); this.unlock = null; throw error; }
  }

  async publish() {
    if (this.stopped || !this.unlock) return;
    const tokens = this.rows.flatMap((row, i) => ['--token', `${HERDR_QUOTA_TOKENS[i].token.slice(1)}=${formatHerdrQuota(row, this.now())}`]);
    await this.run(['workspace', 'report-metadata', this.workspace, '--source', SOURCE, ...tokens, '--ttl-ms', String(this.ttlMs)]);
  }

  refresh(force = false) {
    if (this.stopped || this.disabled) return;
    void this.ready.then(() => {
      if (this.stopped || this.disabled || !this.unlock || this.pending) return;
      this.nextPoll = this.now() + POLL_MS;
      this.pending = Promise.resolve().then(() => this.collector.collect({ force })).then(rows => {
        if (!this.stopped) this.rows = rows;
      }, () => {
        if (!this.stopped) this.rows = ['codex', 'claude'].map(provider => ({ provider, status: 'error' }));
      }).then(() => this.serialize(async () => {
        if (!this.stopped) { await this.syncWorkspace(); await this.publish(); }
      })).finally(() => { this.pending = null; });
    });
  }

  async tick() {
    if (this.stopped || this.disabled) return;
    await this.serialize(async () => {
      if (this.stopped) return;
      await this.syncWorkspace();
      await this.publish();
      if (this.now() >= this.nextPoll) this.refresh();
    });
  }

  async release() {
    if (!this.unlock) return;
    try {
      await this.run(['workspace', 'report-metadata', this.workspace, '--source', SOURCE,
        '--clear-token', 'opm_cx', '--clear-token', 'opm_cc']);
    } catch { /* A disconnected server expires the last report by TTL. */ }
    finally { await this.unlock(); this.unlock = null; }
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    clearInterval(this.timer);
    // Do not wait for provider requests; their completion cannot publish after stop.
    this.stopping = this.ready.then(() => this.queue).then(() => this.release()).catch(() => {});
    return this.stopping;
  }
}
