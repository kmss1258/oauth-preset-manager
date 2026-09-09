import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ActiveQuotaCollector } from './active-quota.js';
import { readBytes } from './codex.js';
import { acquireHerdrLock, ensureHerdrQuotaConfig, registeredSidebarRows, sidebarRowBudget } from './herdr-config.js';
import { SidebarSettings } from './sidebar-settings.js';
import { SystemMetrics } from './system-metrics.js';
import { buildSidebarView } from './sidebar-view.js';
export { compactReset, formatHerdrQuota } from './sidebar-view.js';

const execute = promisify(execFile);
const SOURCE = 'opm:quota';
const POLL_MS = 60_000;
const TICK_MS = 1000;
const TTL_MS = 45_000;
const idle = () => {};

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
  env = process.env, homeDir = homedir(), configDir = join(homeDir, '.config', 'oauth-preset-manager'),
  run = herdrRunner(env), collector, metrics, settingsStore,
  now = Date.now, onWarning = idle, tickMs = TICK_MS, ttlMs = TTL_MS } = {}) {
  if (!interactive || env.HERDR_ENV !== '1' || !env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH) {
    return { ready: Promise.resolve(), refresh: idle, stop: async () => {} };
  }
  return new HerdrQuotaDisplay({ env, homeDir, configDir, run, collector: collector || new ActiveQuotaCollector({ homeDir }),
    metrics: metrics || new SystemMetrics({ now }), settingsStore: settingsStore || new SidebarSettings(configDir),
    now, onWarning, tickMs, ttlMs });
}

class HerdrQuotaDisplay {
  constructor(options) {
    Object.assign(this, options);
    this.rows = ['codex', 'claude'].map(provider => ({ provider, status: 'loading' }));
    this.stopped = false;
    this.queue = Promise.resolve();
    this.nextPoll = 0;
    this.published = new Set(['opm_cx', 'opm_cc']);
    this.ready = this.initialize().catch(async () => {
      this.disabled = true;
      await this.release().catch(() => {});
      this.warn();
    });
    this.ready.then(() => {
      if (this.stopped || this.disabled) return;
      this.timer = setInterval(() => { void this.tick(); }, this.tickMs);
      this.timer.unref?.();
      this.refresh();
      this.pollMetrics();
    });
  }

  warn(reason = 'unavailable') {
    if (this.warned || this.stopped) return;
    this.warned = true;
    this.onWarning(reason);
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
    this.settings = await this.settingsStore.load();
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
      this.lastPayload = null;
    }
    if (this.unlock) return;
    const key = createHash('sha256').update(`${this.sessionKey}:${workspace}`).digest('hex');
    this.unlock = await acquireHerdrLock(join(this.configDir, 'herdr-quota', `${key}.lock`));
  }

  async configure(rows, source) {
    const signature = JSON.stringify(rows);
    if (signature === this.configured && source === this.configuredSource) return;
    for (let attempt = 0; ; attempt++) {
      try { await ensureHerdrQuotaConfig(this.configPath, this.run, rows); break; }
      catch (error) {
        if (error.message !== 'Herdr configuration is busy' || attempt >= 9) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    this.configured = signature;
    this.configuredSource = (await readBytes(this.configPath))?.toString('utf8') || '';
  }

  async publish() {
    if (this.stopped || !this.unlock) return;
    const source = (await readBytes(this.configPath))?.toString('utf8') || '';
    const view = buildSidebarView(this.settings, this.rows, this.metrics.values, this.now(), sidebarRowBudget(source));
    if (view.overflow) this.warn('overflow');
    await this.configure(registeredSidebarRows(source, view.rows), source);
    if (this.stopped) return;
    const payload = JSON.stringify(view.tokens);
    if (payload === this.lastPayload && this.now() - this.lastReport < Math.min(15000, this.ttlMs / 2)) return;
    const removed = [...this.published].filter(key => !Object.hasOwn(view.tokens, key));
    const entries = [...Object.entries(view.tokens), ...removed.map(key => [key, null])];
    for (const [key] of entries) this.published.add(key);
    await this.report(entries);
    this.published = new Set(Object.keys(view.tokens));
    this.lastPayload = payload; this.lastReport = this.now();
  }

  async report(entries) {
    // Herdr accepts at most 16 token patches per call. Keep each row's colors atomic.
    const groups = new Map();
    for (const entry of entries) {
      const group = entry[0].replace(/_(label|value|normal|warning|critical)$/, '');
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(entry);
    }
    let batch = [];
    const send = async () => {
      if (!batch.length) return;
      const args = batch.flatMap(([key, value]) => value === null ? ['--clear-token', key] : ['--token', `${key}=${value}`]);
      await this.run(['workspace', 'report-metadata', this.workspace, '--source', SOURCE, ...args, '--ttl-ms', String(this.ttlMs)]);
      batch = [];
    };
    for (const group of groups.values()) {
      if (batch.length + group.length > 16) await send();
      batch.push(...group);
    }
    await send();
  }

  pollMetrics(force = false) {
    if (this.stopped || this.disabled || !this.unlock) return;
    void this.metrics.poll(this.settings, () => this.serialize(async () => {
      if (!this.stopped) await this.publish();
    }), force);
  }

  refresh(force = false) {
    if (this.stopped || this.disabled) return;
    void this.ready.then(() => {
      if (this.stopped || this.disabled || !this.unlock) return;
      if (force) this.pollMetrics(true);
      if (this.pending) return;
      const providers = ['codex', 'claude'].filter(provider => this.settings[provider]);
      if (!providers.length) return;
      const revision = JSON.stringify(providers);
      this.nextPoll = this.now() + POLL_MS;
      this.pending = Promise.resolve().then(() => this.collector.collect({ force, providers })).then(rows => {
        if (!this.stopped && JSON.stringify(['codex', 'claude'].filter(provider => this.settings[provider])) === revision) this.rows = rows;
      }, () => {
        if (!this.stopped) this.rows = providers.map(provider => ({ provider, status: 'error' }));
      }).then(() => this.serialize(async () => {
        if (!this.stopped) { await this.syncWorkspace(); await this.publish(); }
      })).finally(() => { this.pending = null; });
    });
  }

  async tick() {
    if (this.stopped || this.disabled || this.ticking) return;
    this.ticking = true;
    try {
      await this.serialize(async () => {
        if (this.stopped) return;
        try {
          const next = await this.settingsStore.load();
          if (JSON.stringify(next) !== JSON.stringify(this.settings)) {
            if (next.codex !== this.settings.codex || next.claude !== this.settings.claude) this.nextPoll = 0;
            this.settings = next;
            this.rows = this.rows.filter(row => next[row.provider]);
            this.metrics.deadlines = {};
          }
        } catch { this.warn(); }
        await this.syncWorkspace();
        await this.publish();
        if (this.now() >= this.nextPoll) this.refresh();
        this.pollMetrics();
      });
    } finally { this.ticking = false; }
  }

  async release() {
    if (!this.unlock) return;
    try {
      await this.report([...this.published].map(key => [key, null]));
    } catch { /* A disconnected server expires the last report by TTL. */ }
    finally { await this.unlock(); this.unlock = null; }
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    clearInterval(this.timer);
    // Pending collectors cannot publish after stop; do not wait for external requests.
    this.stopping = this.ready.then(() => this.queue).then(() => this.release()).catch(() => {});
    return this.stopping;
  }
}
