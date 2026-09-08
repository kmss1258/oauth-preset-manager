import { constants, promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import https from 'https';
import { env } from 'process';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { t } from './i18n.js';
import { assertIdentity, checkCodexFileStore, entryIdentity, getCodexAuthPath, getProxyCodexAuthPath, matchesNative, nativeFromEntry, openAIExpires,
  parseAuth, parseNative, pathsOverlap, privateDir, readBytes, refreshedEntry, safePath,
  selectOpenAI, syncError, proxyAuthFromEntry, writeBytesAtomic } from './codex.js';

const ANTIGRAVITY_CLIENT_ID = env.OPM_ANTIGRAVITY_CLIENT_ID?.trim() || '';
const ANTIGRAVITY_CLIENT_SECRET = env.OPM_ANTIGRAVITY_CLIENT_SECRET?.trim() || '';
const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTH_ISSUER = 'https://auth.openai.com';
const OPENAI_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const OPENAI_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const GOOGLE_QUOTA_API_URL = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const GOOGLE_TOKEN_REFRESH_URL = 'https://oauth2.googleapis.com/token';
const COMMAND_CODE_API_URL = 'https://api.commandcode.ai/alpha';
const OPENAI_KICKOFF_MODEL = 'gpt-5.6-luna';
const OPENAI_KICKOFF_INPUT = 'Reply with exactly OK.';

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function validatePresetName(name) {
  const hasControlCharacter = typeof name === 'string' && Array.from(name).some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
  if (typeof name !== 'string' || !name.trim() || ['.', '..', '__proto__', 'constructor', 'prototype'].includes(name)
    || name.includes('\0') || name.includes('/') || name.includes('\\') || /\p{Cf}/u.test(name) || hasControlCharacter) {
    throw new TypeError('Preset name contains unsafe characters');
  }
  return name;
}

function normalizePlanType(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

const GOOGLE_MODEL_KEYS = {
  'gemini-3-pro-high': 'G3Pro',
  'gemini-3-pro-low': 'G3Pro',
  'gemini-3-flash': 'G3Flash',
  'claude-opus-4-5-thinking': 'Claude',
  'claude-opus-4-5': 'Claude',
  'gemini-3-pro-image': 'G3Image',
};

export function getOpenCodeAuthPathCandidates(homeDir = homedir()) {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homeDir, '.local', 'share');
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homeDir, '.config');

  return [
    join(dataHome, 'opencode', 'auth.json'),
    join(configHome, 'opencode', 'auth.json'),
  ];
}

export function getAntigravityAccountsPathCandidates(homeDir = homedir()) {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homeDir, '.local', 'share');
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homeDir, '.config');

  return [
    join(configHome, 'opencode', 'antigravity-accounts.json'),
    join(dataHome, 'opencode', 'antigravity-accounts.json'),
  ];
}

export function getCommandCodeAuthPathCandidates(homeDir = homedir()) {
  const override = env.OPM_COMMAND_CODE_AUTH_PATH?.trim();
  if (override) return [override];

  return [
    join(homeDir, '.commandcode', 'auth.json'),
    join(homeDir, '.commandcode', 'oauth.json'),
  ];
}

export function getClaudeCodeCredentialsPath(homeDir = homedir()) {
  return env.OPM_CLAUDE_AUTH_PATH?.trim()
    || join(env.CLAUDE_CONFIG_DIR?.trim() || join(homeDir, '.claude'), '.credentials.json');
}

async function readQuotaAuth(path) {
  let file;
  try {
    file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const data = JSON.parse(await file.readFile('utf8'));
    // Keep object-shaped invalid presets visible to the caller's validation.
    return data !== null && typeof data === 'object' ? data : null;
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

export function parseClaudeUsage(data) {
  const window = (value, label) => {
    const used = value?.utilization ?? value?.used_percentage ?? value?.percent;
    if (typeof used !== 'number' || !Number.isFinite(used)) return null;
    const reset = value.resets_at;
    const date = typeof reset === 'number' ? new Date(reset < 1e12 ? reset * 1000 : reset)
      : typeof reset === 'string' && reset ? new Date(reset) : null;
    return { label, percent_remaining: Math.round(Math.max(0, Math.min(100, 100 - used))),
      reset_time_iso: date && Number.isFinite(date.getTime()) ? date.toISOString() : null };
  };
  const limits = Array.isArray(data?.limits) ? data.limits.filter(limit => limit && limit.is_active !== false) : [];
  const daily = window(limits.find(limit => limit.kind === 'session'), '5h') || window(data?.five_hour, '5h');
  const weekly = window(limits.find(limit => limit.kind === 'weekly_all'), 'Weekly') || window(data?.seven_day, 'Weekly');
  const scoped = limits.filter(limit => limit.kind === 'weekly_scoped' && limit.group === 'weekly')
    .map(limit => window(limit, typeof limit.scope?.model?.display_name === 'string' ? limit.scope.model.display_name : 'Model')).filter(Boolean);
  const legacy = ['seven_day_opus', 'seven_day_sonnet'].map(key =>
    window(data?.[key], key === 'seven_day_opus' ? 'Opus' : 'Sonnet')).filter(Boolean);
  const extra_windows = scoped.length ? scoped : legacy;
  if (data?.extra_usage?.is_enabled === true) {
    const extra = window(data.extra_usage, 'Extra');
    if (extra) extra_windows.push(extra);
  }
  if (!daily && !weekly && extra_windows.length === 0) throw new Error('Invalid Claude usage response');
  return { daily, weekly, extra_windows };
}

async function findFirstExistingPath(paths) {
  for (const path of paths) {
    if (!path) continue;
    try {
      await fs.access(path);
      return path;
    } catch {}
  }
  return null;
}

export class PresetManager {
  constructor(configDir = null) {
    this.configDir = resolve(configDir || join(homedir(), '.config', 'oauth-preset-manager'));
    this.presetsDir = join(this.configDir, 'presets');
    this.backupsDir = join(this.configDir, 'backups');
    this.sidecarsDir = join(this.configDir, 'preset-sidecars', 'opencode-go');
    this.codexSidecarsDir = join(this.configDir, 'preset-sidecars', 'codex');
    this.refreshRecoveryDir = join(this.configDir, 'refresh-recovery');
    this.configFile = join(this.configDir, 'config.json');
    this.quotaCacheFile = join(this.configDir, 'quota-cache.json');
    this.openCodeGoConfigFile = join(this.configDir, 'opencode-go.json');
    this.config = null;
    this.quotaCache = this._createEmptyQuotaCache();
    this.lastOpenAIRefreshResults = [];
    this._requestJson = httpsRequest;
    this._claudeQuotaCache = new Map();
  }

  async init() {
    for (const path of [this.configDir, this.presetsDir, this.backupsDir, join(this.configDir, 'preset-sidecars'), this.sidecarsDir]) await privateDir(path);
    try {
      const globalStat = await fs.lstat(this.openCodeGoConfigFile);
      if (globalStat.isFile()) await fs.chmod(this.openCodeGoConfigFile, 0o600);
    } catch {}
    this.config = await this._loadConfig();
    this.quotaCache = await this._loadQuotaCache();
    await this._normalizeAuthPath();
  }

  _createEmptyQuotaCache() {
    return {
      version: 1,
      presets: {},
    };
  }

  async _loadConfig() {
    const bytes = await readBytes(this.configFile);
    if (bytes === null) {
      const defaultAuthPath = this.getSuggestedAuthPath();
      return {
        auth_path: defaultAuthPath,
        current_preset: null,
        presets: {},
      };
    }
    const config = parseAuth(bytes);
    if (!isPlainObject(config.presets) || (config.current_preset !== null && typeof config.current_preset !== 'string')) throw syncError('sync_config_error');
    return config;
  }

  getSuggestedAuthPath() {
    return getOpenCodeAuthPathCandidates()[0];
  }

  async _normalizeAuthPath() {
    const envAuthPath = (env.OPM_AUTH_PATH || '').trim();
    if (envAuthPath) {
      return;
    }

    const currentPath = this.config?.auth_path;
    if (currentPath) {
      try {
        await fs.access(currentPath);
        return;
      } catch {}
    }

    const existing = await findFirstExistingPath(getOpenCodeAuthPathCandidates());
    this.config.auth_path = existing || this.getSuggestedAuthPath();
    await this._saveConfig();
  }

  async _saveConfig() {
    await this._writeJsonAtomic(this.configFile, this.config);
  }

  async _loadQuotaCache() {
    try {
      const data = JSON.parse(await fs.readFile(this.quotaCacheFile, 'utf-8'));
      if (typeof data === 'object' && data !== null) {
        return {
          version: 1,
          presets: typeof data.presets === 'object' && data.presets !== null ? data.presets : {},
        };
      }
    } catch {}

    return this._createEmptyQuotaCache();
  }

  async _saveQuotaCache() {
    const tmpPath = `${this.quotaCacheFile}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(this.quotaCache, null, 2));
    await fs.rename(tmpPath, this.quotaCacheFile);
  }

  getAuthPath() {
    const envAuthPath = (env.OPM_AUTH_PATH || '').trim();
    return resolve(envAuthPath || this.config.auth_path || this.getSuggestedAuthPath());
  }

  async setAuthPath(path) {
    this.config.auth_path = path;
    await this._saveConfig();
  }

  async savePreset(name, description = '', watchedServices = null) {
    validatePresetName(name);
    const authPath = this.getAuthPath();
    
    try {
      await fs.access(authPath);
    } catch {
      throw new Error(`Auth file not found: ${authPath}`);
    }

    const authBytes = await readBytes(authPath);
    const authData = parseAuth(authBytes);
    const presetPath = join(this.presetsDir, `${name}.json`);
    const session = await this._readStoredOpenCodeGoSession();
    const sidecarPath = this._sidecarPath(name);
    const previous = await this._captureFileState([presetPath, this.configFile]);
    previous[sidecarPath] = { bytes: await this._readSafeSidecarBytes(sidecarPath) };
    const codexPath = this._codexSidecarPath(name);
    previous[codexPath] = { bytes: await readBytes(codexPath) };
    const codexBytes = await this._findNativeBundle(authData, previous[codexPath].bytes);
    const oldConfig = structuredClone(this.config);
    let sidecarBackupPath = null;
    for (const [path, file] of Object.entries(previous)) {
      if (file.bytes !== null) await this._writePrivateBackup(`before_save_${name}`, file.bytes);
    }
    try {
      await this._writeBytesAtomic(presetPath, authBytes);
      await this._writeCodexSidecar(name, codexBytes);
      // Missing or malformed global Go data is not an explicit session-clear action; preserve an existing sidecar.
      if (session) {
        if (previous[sidecarPath].bytes && !isDeepStrictEqual(await this._parseSessionBytes(previous[sidecarPath].bytes), session)) {
          sidecarBackupPath = await this._writePrivateBackup(`before_preset_${name}_opencode-go`, previous[sidecarPath].bytes);
        }
        if (!previous[sidecarPath].bytes || !isDeepStrictEqual(await this._parseSessionBytes(previous[sidecarPath].bytes), session)) await this._writeJsonAtomic(sidecarPath, session);
      }
      const services = Object.keys(authData);
      const now = new Date().toISOString();
      if (watchedServices === null) watchedServices = ['openai'];
      this.config.presets[name] = { created_at: now, last_used: now, description, services, watched_services: watchedServices,
        codex_linked: Boolean(codexBytes || this.config.presets[name]?.codex_linked) };
      this.config.current_preset = name;
      await this._saveConfig();
    } catch (error) {
      this.config = oldConfig;
      await this._restoreFileState(previous);
      throw error;
    }
    return true;
  }

  _computeAuthDiff(oldAuth, newAuth) {
    const oldServices = new Set(Object.keys(oldAuth));
    const newServices = new Set(Object.keys(newAuth));

    const added = [...newServices].filter(s => !oldServices.has(s));
    const removed = [...oldServices].filter(s => !newServices.has(s));
    const common = [...oldServices].filter(s => newServices.has(s));

    const modified = common.filter(service => {
      return JSON.stringify(oldAuth[service]) !== JSON.stringify(newAuth[service]);
    });

    return {
      added,
      removed,
      modified,
      unchanged: common.filter(s => !modified.includes(s)),
    };
  }

  async switchPreset(name, autoBackup = true) {
    validatePresetName(name);
    const presetPath = join(this.presetsDir, `${name}.json`);
    const presetBytes = await readBytes(presetPath);
    if (presetBytes === null) throw syncError('preset_not_found');
    let newAuth = parseAuth(presetBytes);
    const selection = selectOpenAI(newAuth);
    const authPath = this.getAuthPath();
    if ([this.presetsDir, this.backupsDir, join(this.configDir, 'preset-sidecars'), this.refreshRecoveryDir].some(path => pathsOverlap(path, authPath))
      || [this.configFile, this.openCodeGoConfigFile, this.quotaCacheFile].includes(authPath)) throw syncError('sync_path_error');
    const sidecar = await this._readSidecar(name);
    if (sidecar.error) throw sidecar.error;
    const codexPath = getCodexAuthPath();
    const proxyPath = selection ? getProxyCodexAuthPath() : null;
    const linkPath = this._codexSidecarPath(name);
    if (selection) await checkCodexFileStore(codexPath, this.configDir, authPath, proxyPath);
    const paths = [authPath, presetPath, this.configFile];
    if (sidecar.value) paths.push(this.openCodeGoConfigFile);
    if (selection) paths.push(codexPath, proxyPath, linkPath);
    const previous = await this._captureFileState(paths);
    if (previous[this.configFile].bytes !== null) {
      const diskConfig = parseAuth(previous[this.configFile].bytes);
      if (!isPlainObject(diskConfig.presets)) throw syncError('sync_config_error');
    }
    let oldAuth = {};
    if (previous[authPath].bytes) { try { oldAuth = parseAuth(previous[authPath].bytes); } catch {} }
    const oldConfig = structuredClone(this.config);
    let backupPath = null;
    for (const [path, file] of Object.entries(previous)) {
      if ((selection || autoBackup) && file.bytes !== null) {
        const backup = await this._writePrivateBackup(`before_switch_${name}`, file.bytes);
        if (path === authPath) backupPath = backup;
      }
    }
    let rotated = false;
    let nativeBytes = null;
    let proxyAuth = null;
    if (selection) {
      const hydrated = await this._hydrateOpenAI(newAuth, previous[linkPath].bytes, previous[codexPath].bytes);
      newAuth = hydrated.auth;
      nativeBytes = hydrated.bytes;
      rotated = hydrated.rotated;
      proxyAuth = proxyAuthFromEntry(selectOpenAI(newAuth).entry);
    }
    const diff = this._computeAuthDiff(oldAuth, newAuth);
    try {
      const nextBytes = isDeepStrictEqual(parseAuth(presetBytes), newAuth) ? presetBytes : Buffer.from(JSON.stringify(newAuth, null, 2));
      await this._writeBytesAtomic(authPath, nextBytes);
      if (selection) {
        await this._writeBytesAtomic(codexPath, nativeBytes);
        await privateDir(dirname(dirname(proxyPath)));
        await this._writeJsonAtomic(proxyPath, proxyAuth);
        await this._writeBytesAtomic(presetPath, nextBytes);
        await this._writeCodexSidecar(name, nativeBytes);
      }
      if (sidecar.value) await this._writeJsonAtomic(this.openCodeGoConfigFile, sidecar.value);
      const now = new Date().toISOString();
      this.config.presets[name] = { ...this.config.presets[name], last_used: now, codex_linked: Boolean(selection) };
      this.config.current_preset = name;
      await this._saveConfig();
    } catch (error) {
      this.config = oldConfig;
      try { await this._restoreFileState(previous); }
      catch { throw syncError(rotated ? 'sync_rotated_rollback_error' : 'sync_rollback_error'); }
      if (rotated) throw syncError('sync_rotated_error');
      throw error;
    }

    return {
      success: true,
      preset_name: name,
      source_path: presetPath,
      destination_path: authPath,
      backup_path: backupPath,
      codex_synced: Boolean(selection),
      codex_path: selection ? codexPath : null,
      proxy_synced: Boolean(selection),
      proxy_path: proxyPath,
      diff,
    };
  }

  async overwritePresetFromCurrent(name, autoBackup = true) {
    validatePresetName(name);
    const presetPath = join(this.presetsDir, `${name}.json`);

    try {
      await fs.access(presetPath);
    } catch {
      throw new Error(`Preset not found: ${name}`);
    }

    const authPath = this.getAuthPath();
    try {
      await fs.access(authPath);
    } catch {
      throw new Error(`Auth file not found: ${authPath}`);
    }

    const authBytes = await readBytes(authPath);
    const authData = parseAuth(authBytes);
    const session = await this._readStoredOpenCodeGoSession();
    const sidecarPath = this._sidecarPath(name);
    const previous = await this._captureFileState([presetPath, this.configFile]);
    previous[sidecarPath] = { bytes: await this._readSafeSidecarBytes(sidecarPath) };
    const codexPath = this._codexSidecarPath(name);
    previous[codexPath] = { bytes: await readBytes(codexPath) };
    const codexBytes = await this._findNativeBundle(authData, previous[codexPath].bytes);
    const oldConfig = structuredClone(this.config);
    let backupPath = null;
    let sidecarBackupPath = null;
    if (autoBackup) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      backupPath = await this._writePrivateBackup(`preset_${name}_${timestamp}`, previous[presetPath].bytes);
    }
    if (previous[codexPath].bytes !== null) await this._writePrivateBackup(`before_codex_${name}`, previous[codexPath].bytes);

    try {
      await this._writeBytesAtomic(presetPath, authBytes);
      await this._writeCodexSidecar(name, codexBytes);
      if (session) {
        if (previous[sidecarPath].bytes && !isDeepStrictEqual(await this._parseSessionBytes(previous[sidecarPath].bytes), session)) sidecarBackupPath = await this._writePrivateBackup(`before_preset_${name}_opencode-go`, previous[sidecarPath].bytes);
        if (!previous[sidecarPath].bytes || !isDeepStrictEqual(await this._parseSessionBytes(previous[sidecarPath].bytes), session)) await this._writeJsonAtomic(sidecarPath, session);
      }
      const now = new Date().toISOString();
      if (this.config.presets[name]) this.config.presets[name].last_used = now;
      if (codexBytes) this.config.presets[name] = { ...this.config.presets[name], codex_linked: true };
      this.config.current_preset = name;
      await this._saveConfig();
    } catch (error) {
      this.config = oldConfig;
      await this._restoreFileState(previous);
      throw error;
    }

    return {
      success: true,
      preset_name: name,
      preset_path: presetPath,
      backup_path: backupPath,
      sidecar_backup_path: sidecarBackupPath,
    };
  }

  async listPresets() {
    const presets = [];
    
    try {
      const files = await fs.readdir(this.presetsDir);
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

      for (const file of jsonFiles) {
        const name = file.slice(0, -5);
        const metadata = this.config.presets[name] || {};

        let services = [];
        try {
          const data = JSON.parse(await fs.readFile(join(this.presetsDir, file), 'utf-8'));
          services = Object.keys(data);
        } catch {}

        presets.push({
          name,
          created_at: metadata.created_at || 'Unknown',
          last_used: metadata.last_used || 'Never',
          description: metadata.description || '',
          services,
          quota_snapshot: this.quotaCache?.presets?.[name] || null,
          is_current: name === this.config.current_preset,
        });
      }
    } catch {}

    return presets;
  }

  async getPresetInfo(name) {
    const presetPath = join(this.presetsDir, `${name}.json`);
    
    try {
      await fs.access(presetPath);
    } catch {
      return null;
    }

    const data = JSON.parse(await fs.readFile(presetPath, 'utf-8'));
    const metadata = this.config.presets[name] || {};

    return {
      name,
      services: Object.keys(data),
      metadata,
      is_current: name === this.config.current_preset,
    };
  }

  async deletePreset(name) {
    validatePresetName(name);
    const presetPath = join(this.presetsDir, `${name}.json`);
    
    try {
      await fs.access(presetPath);
    } catch {
      throw new Error(`Preset not found: ${name}`);
    }

    for (const path of [presetPath, this._sidecarPath(name), this._codexSidecarPath(name)]) await safePath(path);
    await fs.unlink(presetPath);
    await fs.unlink(this._sidecarPath(name)).catch(() => {});
    await this._writeCodexSidecar(name, null);

    if (this.config.presets[name]) {
      delete this.config.presets[name];
    }

    if (this.quotaCache?.presets?.[name]) {
      delete this.quotaCache.presets[name];
      await this._saveQuotaCache();
    }

    if (this.config.current_preset === name) {
      this.config.current_preset = null;
    }

    await this._saveConfig();
    return true;
  }

  async detectCurrentPreset() {
    const authPath = this.getAuthPath();
    
    try {
      await fs.access(authPath);
    } catch {
      return null;
    }

    let currentAuth;
    try {
      currentAuth = parseAuth(await readBytes(authPath));
    } catch {
      return null;
    }

    const files = await fs.readdir(this.presetsDir).catch(() => []);
    
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const name = file.slice(0, -5);
        validatePresetName(name);
        const presetAuth = parseAuth(await readBytes(join(this.presetsDir, file)));
        if (!isDeepStrictEqual(currentAuth, presetAuth)) continue;
        const selection = selectOpenAI(presetAuth);
        if (selection) {
          const recovered = await this._recoverOpenAI(selection.entry);
          if (!isDeepStrictEqual(selection.entry, recovered.entry)) continue;
          const linked = await readBytes(this._codexSidecarPath(name));
          if (linked || this.config.presets[name]?.codex_linked) {
            const codexPath = getCodexAuthPath();
            const proxyPath = getProxyCodexAuthPath();
            await checkCodexFileStore(codexPath, this.configDir, authPath, proxyPath);
            if (!linked || !matchesNative(selection.entry, parseNative(linked))) continue;
            const native = parseNative(await readBytes(codexPath));
            if (!matchesNative(selection.entry, native) || native.tokens.id_token !== parseNative(linked).tokens.id_token) continue;
            const proxy = parseAuth(await readBytes(proxyPath));
            if (proxy.accountId !== undefined && proxy.account_id !== undefined && proxy.accountId !== proxy.account_id) continue;
            if (!isDeepStrictEqual(proxyAuthFromEntry(selection.entry), {
              access: proxy.access, refresh: proxy.refresh, expires: proxy.expires, accountId: proxy.accountId ?? proxy.account_id,
            })) continue;
          }
        }
        if (env.OPENCODE_GO_WORKSPACE_ID?.trim() || env.OPENCODE_GO_AUTH_COOKIE?.trim()) {
          return file.slice(0, -5);
        }
        const sidecar = await this._readSidecar(name);
        if (!sidecar.error && sidecar.value) {
          const currentSession = await this._readStoredOpenCodeGoSession();
          if (currentSession && isDeepStrictEqual(currentSession, sidecar.value)) return name;
        } else if (!sidecar.error && !sidecar.exists) {
          return name;
        }
      } catch {}
    }

    return null;
  }

  async listPresetAuthData() {
    const results = [];
    
    try {
      const files = await fs.readdir(this.presetsDir);
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort();

      for (const file of jsonFiles) {
        const name = file.slice(0, -5);
        const data = await readQuotaAuth(join(this.presetsDir, file));
        if (data) results.push([name, data]);
      }
    } catch {}

    return results;
  }

  async getCurrentPresetCredentialOptions() {
    const sourceName = this.config?.current_preset;
    if (!sourceName) {
      throw new Error('No current preset is selected');
    }
    validatePresetName(sourceName);
    const sourcePath = join(this.presetsDir, `${sourceName}.json`);
    let source;
    try { source = JSON.parse(await fs.readFile(sourcePath, 'utf8')); } catch { throw new Error(`Preset not found: ${sourceName}`); }
    if (!isPlainObject(source)) throw new TypeError(`Preset must be a plain object: ${sourceName}`);
    const options = Object.entries(source).map(([service, entry]) => {
      const type = entry && typeof entry === 'object' && typeof entry.type === 'string' && entry.type.trim()
        ? entry.type.trim().toLowerCase() : 'unknown';
      const suffix = service === 'google' && type === 'oauth' ? ' (Gemini/Google)' : '';
      return { authServiceKey: service, service, type, label: `${service}:${type}${suffix}` };
    });
    const session = await this._readStoredOpenCodeGoSession();
    if (session) options.push({
      authServiceKey: null,
      service: 'opencode-go',
      type: 'oauth-session',
      label: 'OpenCode Go OAuth session',
      description: 'Browser/usage session',
    });
    return options;
  }

  async distributeCurrentPresetCredentials({ authServiceKeys = [], includeOpenCodeGoSession = false, targetNames = [] } = {}) {
    if (typeof includeOpenCodeGoSession !== 'boolean') throw new TypeError('includeOpenCodeGoSession must be a boolean');
    if (!Array.isArray(authServiceKeys) || !Array.isArray(targetNames)) throw new TypeError('Credential keys and target names must be arrays');
    const sourceName = this.config?.current_preset;
    if (!sourceName) throw new Error('No current preset is selected');
    validatePresetName(sourceName);
    const sourcePath = join(this.presetsDir, `${sourceName}.json`);
    const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
    if (!isPlainObject(source)) throw new TypeError(`Preset must be a plain object: ${sourceName}`);
    const keys = [...new Set(authServiceKeys)];
    if (keys.some(key => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(source, key))) {
      const invalidKey = keys.find(key => typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(source, key));
      throw new Error(`Credential not found: ${String(invalidKey)}`);
    }
    const session = includeOpenCodeGoSession ? await this._readStoredOpenCodeGoSession() : null;
    if (includeOpenCodeGoSession && !session) throw new Error('Stored OpenCode Go session is missing or malformed');
    const presetData = await this.listPresetAuthData();
    const result = {
      source_preset: sourceName,
      source_entries: keys.length + (includeOpenCodeGoSession ? 1 : 0),
      changed: [],
      unchanged: [],
      source_sidecar_changed: false,
      source_sidecar_backup_path: null,
    };

    const selectedNames = [...new Set(targetNames)].filter(name => name !== sourceName);
    selectedNames.forEach(validatePresetName);
    const presetMap = new Map(presetData);
    const unknownName = selectedNames.find(name => !presetMap.has(name));
    if (unknownName) {
      throw new Error(`Preset not found: ${unknownName}`);
    }
    const malformedTarget = selectedNames.find(name => !isPlainObject(presetMap.get(name)));
    if (malformedTarget) {
      throw new TypeError(`Preset must be a plain object: ${malformedTarget}`);
    }
    const sourceSidecarPath = this._sidecarPath(sourceName);
    const fileState = {};
    const sourceSidecarBytes = await this._readSafeSidecarBytes(sourceSidecarPath);
    fileState[sourceSidecarPath] = { bytes: sourceSidecarBytes };
    const plans = [];
    for (const targetName of selectedNames) {
      const targetPath = join(this.presetsDir, `${targetName}.json`);
      const sidecarPath = this._sidecarPath(targetName);
      const targetBytes = await fs.readFile(targetPath);
      const sidecarBytes = await this._readSafeSidecarBytes(sidecarPath);
      fileState[targetPath] = { bytes: targetBytes };
      fileState[sidecarPath] = { bytes: sidecarBytes };
      const targetAuth = presetMap.get(targetName);
      const nextAuth = structuredClone(targetAuth);
      for (const key of keys) nextAuth[key] = structuredClone(source[key]);
      const codexPath = this._codexSidecarPath(targetName);
      let codexChanged = false;
      if (keys.some(key => key === 'openai' || key === 'codex')) {
        const selection = selectOpenAI(nextAuth);
        const bytes = await readBytes(codexPath);
        fileState[codexPath] = { bytes };
        if (bytes !== null) {
          try { codexChanged = !selection || !matchesNative(selection.entry, parseNative(bytes)); }
          catch { codexChanged = true; }
        }
      }
      plans.push({ targetName, targetPath, sidecarPath, targetAuth, nextAuth, sidecarBytes,
        codexPath, codexChanged,
        authChanged: !isDeepStrictEqual(targetAuth, nextAuth),
        sidecarChanged: Boolean(session) && (!sidecarBytes || !isDeepStrictEqual(await this._parseSessionBytes(sidecarBytes), session)) });
    }

    if (keys.length === 0 && !includeOpenCodeGoSession) {
      result.unchanged = selectedNames.map(preset_name => ({ preset_name }));
      return result;
    }

    const backups = [];
    for (const plan of plans) {
      if (!plan.authChanged && !plan.sidecarChanged && !plan.codexChanged) continue;
      const backupPath = plan.authChanged ? await this._writePrivateBackup(`before_credential_distribution_${plan.targetName}`, fileState[plan.targetPath].bytes) : null;
      const sidecarBackupPath = plan.sidecarChanged && plan.sidecarBytes ? await this._writePrivateBackup(`before_credential_distribution_${plan.targetName}_opencode-go`, plan.sidecarBytes) : null;
      if (plan.codexChanged) await this._writePrivateBackup(`before_codex_distribution_${plan.targetName}`, fileState[plan.codexPath].bytes);
      backups.push({ plan, backupPath, sidecarBackupPath });
    }
    const sourceChanged = includeOpenCodeGoSession && (!sourceSidecarBytes || !isDeepStrictEqual(await this._parseSessionBytes(sourceSidecarBytes), session));
    const sourceBackupPath = sourceChanged && sourceSidecarBytes
      ? await this._writePrivateBackup(`before_credential_distribution_${sourceName}_opencode-go`, sourceSidecarBytes)
      : null;
    try {
      if (sourceChanged) {
        result.source_sidecar_backup_path = sourceBackupPath;
        await this._writeJsonAtomic(sourceSidecarPath, session);
        result.source_sidecar_changed = true;
      }
      for (const { plan, backupPath, sidecarBackupPath } of backups) {
        if (plan.codexChanged) await this._writeCodexSidecar(plan.targetName, null);
        if (plan.authChanged) await this._writeJsonAtomic(plan.targetPath, plan.nextAuth);
        if (plan.sidecarChanged) await this._writeJsonAtomic(plan.sidecarPath, session);
        result.changed.push({ preset_name: plan.targetName, services: keys.slice().sort(), session_changed: plan.sidecarChanged, backup_path: backupPath, sidecar_backup_path: sidecarBackupPath });
      }
      result.unchanged = plans.filter(plan => !plan.authChanged && !plan.sidecarChanged && !plan.codexChanged).map(plan => ({ preset_name: plan.targetName }));
    } catch (error) {
      await this._restoreFileState(fileState);
      throw error;
    }

    return result;
  }

  async propagateCurrentPresetOAuth(targetNames = []) {
    if (!Array.isArray(targetNames)) throw new TypeError('Target preset names must be an array');
    const options = await this.getCurrentPresetCredentialOptions();
    const sourcePath = join(this.presetsDir, `${this.config.current_preset}.json`);
    const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
    const eligible = Object.entries(source)
      .filter(([service, entry]) => entry && typeof entry === 'object'
        && ['refresh', 'access', 'key'].some(key => typeof entry[key] === 'string' && entry[key].trim())
        && (entry.type === 'oauth' || ['command-code', 'commandcode'].includes(service)))
      .map(([service]) => service);
    return this.distributeCurrentPresetCredentials({
      authServiceKeys: options.filter(option => eligible.includes(option.authServiceKey)).map(option => option.authServiceKey),
      targetNames,
    });
  }

  _sidecarPath(name) { return join(this.sidecarsDir, `${name}.json`); }

  _codexSidecarPath(name) { validatePresetName(name); return join(this.codexSidecarsDir, `${name}.json`); }

  async _writeCodexSidecar(name, bytes) {
    const path = this._codexSidecarPath(name);
    if (bytes !== null) await this._writeBytesAtomic(path, bytes);
    else {
      await safePath(path);
      await fs.unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async _findNativeBundle(auth, stored = null, current = undefined) {
    const selection = selectOpenAI(auth);
    if (!selection || !selection.entry.access || !selection.entry.refresh) return null;
    const { entry } = selection;
    const match = bytes => {
      if (bytes === null) return null;
      try { return matchesNative(entry, parseNative(bytes)) ? bytes : null; } catch { return null; }
    };
    if (match(stored)) return stored;
    if (current === undefined) {
      const path = getCodexAuthPath();
      if (pathsOverlap(dirname(path), this.configDir)) throw syncError('sync_path_error');
      current = await readBytes(path);
    }
    if (match(current)) return current;
    if (entry.id_token || entry.idToken) {
      try { return Buffer.from(JSON.stringify(nativeFromEntry(entry, entry.id_token || entry.idToken, entry.last_refresh), null, 2)); } catch {}
    }
    return null;
  }

  _withOpenAIEntry(auth, entry) {
    const next = structuredClone(auth);
    for (const key of selectOpenAI(auth).keys) {
      for (const field of ['access', 'refresh', 'expires', 'accountId', 'id_token', 'idToken', 'last_refresh', 'opm_identity']) {
        if (Object.hasOwn(entry, field)) next[key][field] = entry[field];
        else delete next[key][field];
      }
    }
    return next;
  }

  _recoveryPath(refresh) {
    return join(this.refreshRecoveryDir, `${createHash('sha256').update(refresh).digest('hex')}.json`);
  }

  async _recoverOpenAI(original, allowUncertain = false) {
    let entry = { ...original };
    let rotated = false;
    const visited = new Set();
    while (typeof entry.refresh === 'string' && entry.refresh) {
      if (visited.has(entry.refresh)) throw syncError('sync_recovery_error');
      visited.add(entry.refresh);
      const bytes = await readBytes(this._recoveryPath(entry.refresh));
      if (bytes === null) break;
      const log = parseAuth(bytes);
      if (log.status !== 'received' || log.source_refresh !== entry.refresh || !isPlainObject(log.source_identity)
        || !Array.isArray(log.source_accesses) || log.source_accesses.some(value => typeof value !== 'string')) throw syncError('sync_recovery_error');
      let next;
      try {
        const context = assertIdentity(entryIdentity(entry), log.source_identity);
        next = refreshedEntry({ ...entry, opm_identity: context }, log.response, log.received_at);
      }
      catch { throw syncError('sync_recovery_error'); }
      if (next.refresh === entry.refresh && !log.source_accesses.includes(entry.access)
        && entry.access !== next.access) {
        // Opaque access tokens cannot establish whether an unknown login is newer or older.
        if (!allowUncertain) throw syncError('sync_recovery_error');
        return { entry: { ...entry, opm_identity: assertIdentity(entryIdentity(entry), entryIdentity(next)) }, rotated, needsRefresh: true };
      }
      rotated = true;
      const sameRefresh = next.refresh === entry.refresh;
      entry = next;
      if (sameRefresh) break;
    }
    return { entry, rotated };
  }

  async _requestOpenAIRefresh(entry) {
    if (typeof entry.refresh !== 'string' || !entry.refresh.trim()) throw syncError('sync_refresh_error');
    const path = this._recoveryPath(entry.refresh);
    const previous = await readBytes(path);
    if (previous !== null) await this._writePrivateBackup('before_refresh_recovery', previous);
    const sourceAccesses = [...new Set([...(previous ? parseAuth(previous).source_accesses || [] : []), entry.access].filter(value => typeof value === 'string'))];
    const sourceIdentity = entryIdentity(entry);
    // The pending record prevents a later switch from silently reusing possibly spent tokens.
    await this._writeJsonAtomic(path, { status: 'pending', source_refresh: entry.refresh, source_accesses: sourceAccesses, source_identity: sourceIdentity });
    let response;
    try { response = await refreshOpenAIToken(entry.refresh, this._requestJson); }
    catch { throw syncError('sync_refresh_uncertain'); }
    const receivedAt = new Date().toISOString();
    const log = { status: 'received', source_refresh: entry.refresh, source_accesses: sourceAccesses, source_identity: sourceIdentity, received_at: receivedAt, response: {} };
    for (const key of ['id_token', 'access_token', 'refresh_token', 'expires_in']) {
      if (response && Object.hasOwn(response, key)) log.response[key] = response[key];
    }
    try { await this._writeJsonAtomic(path, log); }
    catch {
      // A second independent private copy may still succeed after a rename/metadata failure.
      try { await this._writePrivateBackup('rotated_openai_recovery', Buffer.from(JSON.stringify(log))); } catch {}
      throw syncError('sync_recovery_write_error');
    }
    // Never roll this record back: OAuth rotation is outside the filesystem transaction.
    try { return refreshedEntry(entry, log.response, receivedAt); }
    catch { throw syncError('sync_recovery_error'); }
  }

  async _hydrateOpenAI(auth, stored, current) {
    const original = selectOpenAI(auth).entry;
    const originalBytes = await this._findNativeBundle(auth, stored, current);
    const recovered = await this._recoverOpenAI(originalBytes ? { ...original, id_token: parseNative(originalBytes).tokens.id_token } : original, true);
    let entry = recovered.rotated || recovered.needsRefresh ? recovered.entry : { ...original };
    let rotated = recovered.rotated;
    let bytes = !rotated ? originalBytes : !entry.id_token ? null : await this._findNativeBundle(this._withOpenAIEntry(auth, entry), stored, current);
    let expires = openAIExpires(entry);
    if (recovered.needsRefresh || !bytes || expires === null || expires <= Date.now()) {
      const priorNative = bytes ? parseNative(bytes) : null;
      entry = await this._requestOpenAIRefresh(priorNative ? { ...entry, id_token: priorNative.tokens.id_token } : entry);
      rotated = true;
      try {
        const next = nativeFromEntry(entry, entry.id_token, entry.last_refresh);
        bytes = Buffer.from(JSON.stringify({ ...priorNative, ...next, tokens: { ...priorNative?.tokens, ...next.tokens } }, null, 2));
      }
      catch { throw syncError('sync_recovery_error'); }
      expires = openAIExpires(entry);
      if (expires === null || expires <= Date.now()) throw syncError('sync_recovery_error');
    }
    entry.expires = expires;
    entry.accountId = parseNative(bytes).tokens.account_id;
    return { auth: this._withOpenAIEntry(auth, entry), bytes, rotated };
  }

  async _readStoredOpenCodeGoSession() {
    try {
      const fileStat = await fs.lstat(this.openCodeGoConfigFile);
      if (!fileStat.isFile()) return null;
      const parsed = JSON.parse(await fs.readFile(this.openCodeGoConfigFile, 'utf8'));
      if (typeof parsed?.workspaceId !== 'string' || !parsed.workspaceId.trim() || typeof parsed?.authCookie !== 'string' || !parsed.authCookie.trim()) return null;
      return { workspaceId: parsed.workspaceId.trim(), authCookie: parsed.authCookie.trim() };
    } catch { return null; }
  }

  async _parseSessionBytes(bytes) {
    try {
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!isPlainObject(parsed) || Object.keys(parsed).sort().join(',') !== 'authCookie,workspaceId') return null;
      if (typeof parsed?.workspaceId !== 'string' || !parsed.workspaceId.trim() || typeof parsed?.authCookie !== 'string' || !parsed.authCookie.trim()) return null;
      return { workspaceId: parsed.workspaceId.trim(), authCookie: parsed.authCookie.trim() };
    } catch { return null; }
  }

  async _readSidecar(name) {
    try {
      const bytes = await this._readSafeSidecarBytes(this._sidecarPath(name));
      if (bytes === null) return { exists: false, value: null };
      const value = await this._parseSessionBytes(bytes);
      return value ? { exists: true, value } : { exists: true, error: new Error(`Invalid OpenCode Go sidecar: ${name}`) };
    } catch (error) {
      if (error.code === 'ENOENT') return { exists: false, value: null };
      throw error;
    }
  }

  async _readSafeSidecarBytes(path) {
    return readBytes(path);
  }

  async _readSafeGlobalBytes() {
    try {
      const fileStat = await fs.lstat(this.openCodeGoConfigFile);
      if (fileStat.isSymbolicLink()) throw new Error(`Unsafe OpenCode Go global session path: ${this.openCodeGoConfigFile}`);
      if (!fileStat.isFile()) return null;
      return await fs.readFile(this.openCodeGoConfigFile);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async _writeBytesAtomic(path, bytes) {
    await writeBytesAtomic(path, bytes);
  }

  async _writeJsonAtomic(path, data) {
    await this._writeBytesAtomic(path, Buffer.from(JSON.stringify(data, null, 2)));
  }

  async _captureFileState(paths) {
    const state = {};
    for (const path of paths) state[path] = { bytes: await readBytes(path) };
    return state;
  }

  async _restoreFileState(state) {
    let failed = false;
    for (const [path, file] of Object.entries(state)) {
      try {
        await safePath(path);
        if (file.bytes === null) await fs.unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        else await this._writeBytesAtomic(path, file.bytes);
      } catch { failed = true; }
    }
    if (failed) throw syncError('sync_rollback_error');
  }

  async _writePrivateBackup(prefix, bytes) {
    const path = join(this.backupsDir, `${prefix}_${Date.now()}_${randomUUID()}.json`);
    await this._writeBytesAtomic(path, bytes);
    return path;
  }

  async _refreshExpiredOpenAICredentials() {
    const presetFiles = await fs.readdir(this.presetsDir).catch(() => []);
    const targets = [
      { path: this.getAuthPath(), preset_name: 'Current Active', is_active: true },
      ...presetFiles
        .filter(file => file.endsWith('.json'))
        .map(file => ({
          path: join(this.presetsDir, file),
          preset_name: file.slice(0, -5),
          is_active: false,
        })),
    ];

    const makeResult = (record, success, error = null) => ({
      preset_name: record.preset_name,
      is_active: record.is_active,
      success,
      error,
    });
    const results = [];
    const groups = new Map();
    for (const target of targets) {
      try {
        const bytes = await readBytes(target.path);
        if (bytes === null) continue;
        const data = parseAuth(bytes);
        const selection = selectOpenAI(data);
        if (!selection) continue;
        let original = selection.entry;
        if (!target.is_active) {
          const linked = await readBytes(this._codexSidecarPath(target.preset_name));
          if (linked) {
            try {
              const native = parseNative(linked);
              if (matchesNative(original, native)) original = { ...original, id_token: native.tokens.id_token };
            } catch {}
          }
        }
        const recovered = await this._recoverOpenAI(original);
        const entry = recovered.entry;
        if (!recovered.rotated && (typeof entry.expires !== 'number' || entry.expires > Date.now())) continue;
        if (typeof entry.refresh !== 'string' || !entry.refresh) {
          results.push(makeResult(target, false, 'No refresh token is available'));
          continue;
        }
        const group = groups.get(entry.refresh) || [];
        group.push({ ...target, data, entry });
        groups.set(entry.refresh, group);
      } catch (error) { results.push(makeResult(target, false, error.opmKey ? t(error.opmKey) : t('sync_operation_error'))); }
    }
    const groupResults = await Promise.all(Array.from(groups.values()).map(async group => {
      let entry;
      try {
        const context = assertIdentity(...group.map(record => entryIdentity(record.entry)));
        for (const record of group) {
          const paths = [record.path];
          if (!record.is_active) paths.push(this._codexSidecarPath(record.preset_name));
          record.previous = await this._captureFileState(paths);
          for (const file of Object.values(record.previous)) {
            if (file.bytes !== null) await this._writePrivateBackup('before_quota_refresh', file.bytes);
          }
        }
        entry = (group.find(record => record.entry.id_token) || group[0]).entry;
        entry = { ...entry, opm_identity: context };
        if (typeof entry.expires !== 'number' || entry.expires <= Date.now()) entry = await this._requestOpenAIRefresh(entry);
      } catch (error) {
        return group.map(record => makeResult(record, false, error.opmKey ? t(error.opmKey) : t('sync_operation_error')));
      }
      return Promise.all(group.map(async record => {
        try {
          const nextEntry = { ...entry, accountId: entry.accountId || record.entry.accountId };
          const updated = this._withOpenAIEntry(record.data, nextEntry);
          if (!record.is_active) {
            let native = null;
            if (entry.id_token) native = Buffer.from(JSON.stringify(nativeFromEntry(entry, entry.id_token, entry.last_refresh), null, 2));
            await this._writeCodexSidecar(record.preset_name, native);
          }
          await this._writeJsonAtomic(record.path, updated);
          return makeResult(record, true);
        } catch {
          try { await this._restoreFileState(record.previous); }
          catch { return makeResult(record, false, t('sync_rotated_rollback_error')); }
          return makeResult(record, false, t('sync_rotated_error'));
        }
      }));
    }));

    results.push(...groupResults.flat());
    return results.sort((a, b) => {
      if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
      return a.preset_name.localeCompare(b.preset_name, undefined, { sensitivity: 'base' });
    });
  }

  async collectOpenAIQuota() {
    const tokenMap = new Map();

    const formatPresetLabel = (name) => {
      const path = join(this.presetsDir, `${name}.json`);
      const display = path.replace(homedir(), '~');
      return `${name} (${display})`;
    };

    const presetData = await this.listPresetAuthData();
    
    for (const [presetName, authData] of presetData) {
      const entry = this._extractOpenAIOAuth(authData);
      if (!entry || !entry.access) continue;

      const identity = this._extractOpenAIIdentity(entry.access, entry.account_id);
      const planType = normalizePlanType(identity.plan_type);
      const existing = tokenMap.get(entry.access);
      if (existing) {
        existing.presets.push(formatPresetLabel(presetName));
        existing.preset_names.push(presetName);
        if (!existing.nickname) {
          existing.nickname = presetName;
        }
      } else {
        tokenMap.set(entry.access, {
          access: entry.access,
          expires: entry.expires,
          account_id: identity.account_id || entry.account_id,
          plan_type: planType,
          presets: [formatPresetLabel(presetName)],
          preset_names: [presetName],
          nickname: presetName,
        });
      }
    }

    if (tokenMap.size === 0) {
      return [];
    }

    const results = [];
    const promises = [];

    for (const item of tokenMap.values()) {
      promises.push(
        this._fetchOpenAIQuotaForToken(item.access, item.expires, item.account_id, 10, item.plan_type)
          .then(result => {
            result.presets = item.presets.sort();
            result.preset_names = item.preset_names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            if (item.nickname) {
              result.nickname = item.nickname;
            }
            results.push(result);
          })
          .catch(() => {})
      );
    }

    await Promise.all(promises);
    return results;
  }

  async collectActiveQuota() {
    const tasks = [];
    const authPath = this.getAuthPath();
    let displayPath = authPath;
    try {
      displayPath = authPath.replace(homedir(), '~');
    } catch {}

    const activeLabel = `(Current Active: ${displayPath})`;

    try {
      await fs.access(authPath);
      const authData = JSON.parse(await fs.readFile(authPath, 'utf-8'));
      const openaiEntry = this._extractOpenAIOAuth(authData);
      if (openaiEntry && openaiEntry.access) {
        const identity = this._extractOpenAIIdentity(openaiEntry.access, openaiEntry.account_id);
        tasks.push({
          func: this._fetchOpenAIQuotaForToken.bind(this),
          args: [openaiEntry.access, openaiEntry.expires, identity.account_id || openaiEntry.account_id, 10, identity.plan_type],
          presets: [activeLabel],
          accId: null,
        });
      }
    } catch {}

    const agPath = await getAntigravityAccountsPath();
    for (const account of await extractAntigravityAccounts(agPath)) {
      tasks.push({
        func: this._fetchGoogleQuotaForToken.bind(this),
        args: [null, account.refresh, account.project_id],
        presets: [`(Antigravity: ${account.email || 'User'})`],
        accId: account.project_id,
        nickname: account.email || null,
      });
    }

    if (tasks.length === 0) {
      return [];
    }

    const results = [];
    const promises = tasks.map(task =>
      task.func(...task.args)
        .then(res => {
          if (Array.isArray(res)) {
            for (const r of res) {
              r.presets = task.presets;
              if ((!r.account_id || r.account_id === 'unknown-project') && task.accId) {
                r.account_id = task.accId;
              }
              if (task.nickname) {
                r.nickname = task.nickname;
              }
              results.push(r);
            }
          } else {
            res.presets = task.presets;
            if (task.nickname) {
              res.nickname = task.nickname;
            }
            results.push(res);
          }
        })
        .catch(() => {})
    );

    await Promise.all(promises);
    return results;
  }

  async collectAllQuota() {
    this.lastOpenAIRefreshResults = await this._refreshExpiredOpenAICredentials();

    const [active, openai, opencodego, commandcode, claude] = await Promise.all([
      this.collectActiveQuota(),
      this.collectOpenAIQuota(),
      this.collectOpenCodeGoQuota(),
      this.collectCommandCodeQuota(),
      this.collectClaudeCodeQuota(),
    ]);
    return [...active, ...openai, ...opencodego, ...commandcode, ...claude];
  }

  async collectClaudeCodeQuota() {
    const targets = new Map();
    const add = (entry, source) => {
      const access = entry?.accessToken ?? entry?.access;
      if (typeof access !== 'string' || !access.trim()) return;
      const token = access.trim();
      if (token.startsWith('sk-ant-api')) return;
      const id = createHash('sha256').update(token).digest('hex');
      const existing = targets.get(id);
      if (existing) { existing.presets.push(source); return; }
      targets.set(id, { token, expires: entry.expiresAt ?? entry.expires,
        scopes: entry.scopes, id, presets: [source] });
    };
    const local = await readQuotaAuth(getClaudeCodeCredentialsPath());
    add(local?.claudeAiOauth, '(Claude Code)');
    const active = await readQuotaAuth(this.getAuthPath());
    if (active?.anthropic?.type === 'oauth') add(active.anthropic, '(Current Active: Anthropic)');
    for (const [name, auth] of await this.listPresetAuthData()) {
      if (auth?.anthropic?.type === 'oauth') add(auth.anthropic, name);
    }
    // Never persist tokens, refresh them, or rotate another CLI's credentials.
    for (const id of this._claudeQuotaCache.keys()) if (!targets.has(id)) this._claudeQuotaCache.delete(id);
    return Promise.all([...targets.values()].map(async target => {
      const result = { provider: 'claude', account_id: `claude-${target.id.slice(0, 12)}`,
        presets: target.presets, daily: null, weekly: null, error: null };
      if (target.expires != null && (!Number.isFinite(Number(target.expires)) || Number(target.expires) <= Date.now())) {
        return { ...result, error: t('quota_claude_expired') };
      }
      // OpenCode omits scope metadata; in that case the API enforces permission.
      if (target.scopes != null && (!Array.isArray(target.scopes) || !target.scopes.includes('user:profile'))) {
        return { ...result, error: t('quota_claude_scope') };
      }
      const cached = this._claudeQuotaCache.get(target.id);
      if (cached && cached.until > Date.now()) return { ...result, ...cached.usage };
      let usage;
      let delay = 60_000;
      try {
        const data = await this._requestJson('https://api.anthropic.com/api/oauth/usage', {
          method: 'GET', headers: { Authorization: `Bearer ${target.token}`,
            'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json', 'Content-Type': 'application/json' },
        }, 10_000);
        usage = { ...parseClaudeUsage(data), error: null };
      } catch (error) {
        const status = error.statusCode;
        const key = status === 401 ? 'quota_claude_expired' : status === 403 ? 'quota_claude_scope'
          : status === 429 ? 'quota_claude_rate_limited' : 'quota_claude_failed';
        usage = { error: t(key) };
        delay = 0;
        if (status === 429) {
          const retry = error.retryAfter;
          const seconds = typeof retry === 'string' && /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          delay = Math.max(60_000, Number.isFinite(seconds) ? seconds : 300_000);
        }
      }
      if (delay > 0) this._claudeQuotaCache.set(target.id, { until: Date.now() + delay, usage });
      else this._claudeQuotaCache.delete(target.id);
      return { ...result, ...usage };
    }));
  }

  async _getOpenCodeGoCredentials() {
    let config = {};
    try {
      const bytes = await this._readSafeGlobalBytes();
      const parsed = bytes === null ? null : JSON.parse(bytes.toString('utf8'));
      if (parsed && typeof parsed === 'object') config = parsed;
    } catch {}

    return {
      workspaceId: env.OPENCODE_GO_WORKSPACE_ID?.trim() || (typeof config.workspaceId === 'string' ? config.workspaceId.trim() : ''),
      authCookie: env.OPENCODE_GO_AUTH_COOKIE?.trim() || (typeof config.authCookie === 'string' ? config.authCookie.trim() : ''),
    };
  }

  async collectOpenCodeGoQuota() {
    const { workspaceId, authCookie } = await this._getOpenCodeGoCredentials();
    if (!workspaceId || !authCookie) return [];

    try {
      const url = 'https://opencode.ai/workspace/' + encodeURIComponent(workspaceId) + '/go';
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Cookie': 'auth=' + authCookie,
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return [];

      const html = await response.text();
      const patterns = [
        ['rolling', /rollingUsage:\$R\[\d+\]=(\{[^}]+\})/],
        ['weekly', /weeklyUsage:\$R\[\d+\]=(\{[^}]+\})/],
        ['monthly', /monthlyUsage:\$R\[\d+\]=(\{[^}]+\})/],
      ];

      const usage = {};
      for (const [key, re] of patterns) {
        const match = html.match(re);
        if (!match) continue;
        try {
          const jsonStr = match[1].replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
          usage[key] = JSON.parse(jsonStr);
        } catch {}
      }

      if (!usage.rolling && !usage.weekly && !usage.monthly) return [];

      const daily = usage.rolling ? {
        percent_remaining: Math.round(100 - usage.rolling.usagePercent),
        reset_time_iso: usage.rolling.resetInSec ? new Date(Date.now() + usage.rolling.resetInSec * 1000).toISOString() : null,
      } : null;

      const weekly = usage.weekly ? {
        percent_remaining: Math.round(100 - usage.weekly.usagePercent),
        reset_time_iso: usage.weekly.resetInSec ? new Date(Date.now() + usage.weekly.resetInSec * 1000).toISOString() : null,
      } : null;

      return [{
        provider: 'opencodego',
        account_id: workspaceId,
        daily,
        weekly,
        monthly_percent: usage.monthly ? Math.round(100 - usage.monthly.usagePercent) : null,
        monthly_reset_iso: usage.monthly?.resetInSec ? new Date(Date.now() + usage.monthly.resetInSec * 1000).toISOString() : null,
        error: null,
      }];
    } catch {
      return [];
    }
  }

  async collectCommandCodeQuota() {
    const authPath = await findFirstExistingPath(getCommandCodeAuthPathCandidates());
    if (!authPath) return [];

    let credential;
    try {
      const authData = JSON.parse(await fs.readFile(authPath, 'utf-8'));
      credential = authData?.apiKey
        || authData?.['command-code']?.key
        || authData?.commandcode?.access
        || authData?.commandcode?.key;
    } catch {
      return [];
    }

    if (typeof credential !== 'string' || !credential.trim()) return [];

    const request = (path, query = {}) => {
      const params = new URLSearchParams(
        Object.entries(query).filter(([, value]) => value != null && value !== '')
      ).toString();
      return this._requestJson(`${COMMAND_CODE_API_URL}${path}${params ? `?${params}` : ''}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${credential.trim()}`,
          Accept: 'application/json',
        },
      }, 10000);
    };

    try {
      const whoami = await request('/whoami');
      const orgId = whoami?.org?.id;
      const credits = await request('/billing/credits', { orgId });
      const [subscription, usage] = await Promise.all([
        request('/billing/subscriptions', { orgId }).catch(() => null),
        request('/usage/summary', { orgId }).catch(() => null),
      ]);
      const fiveHour = credits?.windowLimits?.fiveHour;
      const weeklyWindow = credits?.windowLimits?.weekly;
      const toRemaining = (window) => {
        if (!window || !Number.isFinite(Number(window.cap))) return null;
        const remaining = 100 - (Number(window.used || 0) / Number(window.cap)) * 100;
        return Math.max(0, Math.min(100, Math.round(remaining)));
      };
      const toReset = (window) => {
        if (!window?.resetAt) return null;
        if (typeof window.resetAt === 'string' && Number.isNaN(Number(window.resetAt))) {
          return new Date(window.resetAt).toISOString();
        }
        return resetTimeIsoFromSeconds(Number(window.resetAt));
      };
      const displayPath = authPath.replace(homedir(), '~');
      const monthlyCredits = Number(credits?.credits?.monthlyCredits || 0);
      const purchasedCredits = Number(credits?.credits?.purchasedCredits || 0);
      const freeCredits = Number(credits?.credits?.freeCredits || 0);

      return [{
        provider: 'commandcode',
        account_id: orgId || whoami?.user?.userName || 'command-code',
        nickname: whoami?.user?.userName || null,
        presets: [`(Command Code: ${displayPath})`],
        daily: fiveHour ? {
          percent_remaining: toRemaining(fiveHour),
          reset_time_iso: toReset(fiveHour),
        } : null,
        weekly: weeklyWindow ? {
          percent_remaining: toRemaining(weeklyWindow),
          reset_time_iso: toReset(weeklyWindow),
        } : null,
        command_code_credits: {
          monthly: monthlyCredits,
          purchased: purchasedCredits,
          free: freeCredits,
          total_remaining: monthlyCredits + purchasedCredits + freeCredits,
        },
        command_code_usage: {
          total_cost: Number(usage?.totalCost || 0),
          total_count: Number(usage?.totalCount || 0),
          total_tokens: Number(usage?.totalTokens || 0),
        },
        command_code_period: {
          start: subscription?.data?.currentPeriodStart || null,
          end: subscription?.data?.currentPeriodEnd || null,
        },
        error: null,
      }];
    } catch (error) {
      return [{
        provider: 'commandcode',
        account_id: 'command-code',
        presets: [`(Command Code: ${authPath.replace(homedir(), '~')})`],
        daily: null,
        weekly: null,
        error: `Command Code API error: ${error.message}`,
      }];
    }
  }

  _extractPresetNameFromLabel(label) {
    if (!label || label.startsWith('(')) return null;
    const idx = label.indexOf(' (');
    if (idx > 0) return label.slice(0, idx);
    return label;
  }

  async cacheQuotaResults(results, fetchedAt = new Date().toISOString()) {
    if (!Array.isArray(results) || results.length === 0) {
      return;
    }

    let changed = false;
    const presets = this.quotaCache.presets || {};

    for (const result of results) {
      if (result?.provider !== 'openai') continue;

      const presetNames = Array.isArray(result.preset_names) && result.preset_names.length > 0
        ? result.preset_names.slice()
        : (result.presets || [])
            .map(label => this._extractPresetNameFromLabel(label))
            .filter(Boolean);

      if (presetNames.length === 0) continue;

      for (const presetName of presetNames) {
        const existing = presets[presetName] || null;
        const next = {
          provider: 'openai',
          account_id: result.account_id || existing?.account_id || null,
          daily_percent: existing?.daily_percent ?? null,
          weekly_percent: existing?.weekly_percent ?? null,
          last_attempt_at: fetchedAt,
          last_success_at: existing?.last_success_at || null,
          last_error: result.error || null,
        };

        if (!result.error) {
          next.daily_percent = result.daily?.percent_remaining ?? null;
          next.weekly_percent = result.weekly?.percent_remaining ?? null;
          next.last_success_at = fetchedAt;
          next.last_error = null;
        }

        if (JSON.stringify(existing) !== JSON.stringify(next)) {
          presets[presetName] = next;
          changed = true;
        }
      }
    }

    if (!changed) {
      return;
    }

    this.quotaCache = {
      version: 1,
      presets,
    };
    await this._saveQuotaCache();
  }

  _extractOpenAIOAuth(authData, strict = false) {
    let entry;
    try { entry = selectOpenAI(authData)?.entry; } catch (error) { if (strict) throw error; return null; }
    if (!entry || typeof entry !== 'object') return null;
    if (entry.type !== 'oauth') return null;
    if (!entry.access) return null;
    
    return {
      ...entry,
      account_id: entry.accountId,
    };
  }

  _extractOpenAIIdentity(accessToken, accountId = null) {
    const payload = parseJWTPayload(accessToken);
    const authSection = payload?.['https://api.openai.com/auth'];
    const profile = payload?.['https://api.openai.com/profile'];

    return {
      account_id: accountId || this._openaiAccountIdFromJWT(accessToken),
      user_id: typeof authSection?.chatgpt_user_id === 'string' ? authSection.chatgpt_user_id : null,
      email: typeof profile?.email === 'string' ? profile.email : null,
      plan_type: normalizePlanType(authSection?.chatgpt_plan_type),
    };
  }

  async collectOpenAIKickoffTargets() {
    const tokenMap = new Map();

    const addTarget = async (entry, label, nickname = null) => {
      if (!entry?.access) return;
      if (nickname !== null) {
        const linked = await readBytes(this._codexSidecarPath(nickname));
        if (linked) {
          const native = parseNative(linked);
          if (native.tokens.access_token === entry.access && native.tokens.refresh_token === entry.refresh) {
            const context = assertIdentity(entryIdentity(entry), entryIdentity({ access: entry.access,
              id_token: native.tokens.id_token, accountId: native.tokens.account_id }));
            entry = { ...entry, id_token: entry.id_token || entry.idToken || native.tokens.id_token, opm_identity: context };
          }
        }
      }
      // Resolve every source before batching: distinct old refresh tokens can converge.
      ({ entry } = await this._recoverOpenAI(entry));
      const key = entry.refresh ? `refresh:${entry.refresh}` : `access:${entry.access}`;
      const identity = this._extractOpenAIIdentity(entry.access, entry.account_id);
      const context = entryIdentity(entry);
      const resolvedAccountId = context.account || identity.account_id || null;
      const existing = tokenMap.get(key);

      if (existing) {
        existing.opm_identity = assertIdentity(entryIdentity(existing), context);
        existing.account_id = existing.opm_identity.account || existing.account_id;
        existing.accountId = existing.account_id;
        existing.user_id = existing.opm_identity.user || existing.user_id;
        existing.labels.add(label);
        if (!existing.nickname && nickname) {
          existing.nickname = nickname;
        }
        return;
      }

      tokenMap.set(key, {
        ...entry,
        opm_identity: context,
        accountId: resolvedAccountId,
        account_id: resolvedAccountId,
        user_id: context.user || identity.user_id,
        email: identity.email,
        plan_type: identity.plan_type,
        labels: new Set([label]),
        nickname: nickname || identity.email || null,
      });
    };

    const authPath = this.getAuthPath();
    const activeBytes = await readBytes(authPath);
    if (activeBytes !== null) {
      const entry = this._extractOpenAIOAuth(parseAuth(activeBytes), true);
      await addTarget(entry, `(Current Active: ${authPath.replace(homedir(), '~')})`, null);
    }

    const presetData = await this.listPresetAuthData();
    for (const [presetName, authData] of presetData) {
      const entry = this._extractOpenAIOAuth(authData, true);
      if (!entry) continue;
      const display = join(this.presetsDir, `${presetName}.json`).replace(homedir(), '~');
      await addTarget(entry, `${presetName} (${display})`, presetName);
    }

    return Array.from(tokenMap.values()).map(target => ({
      ...target,
      presets: Array.from(target.labels).sort(),
    }));
  }

  async runOpenAIKickoffBatch(timeoutSeconds = 30) {
    const targets = await this.collectOpenAIKickoffTargets();
    if (targets.length === 0) {
      return {
        model: OPENAI_KICKOFF_MODEL,
        prompt: OPENAI_KICKOFF_INPUT,
        results: [],
      };
    }

    const results = await Promise.all(
      targets.map(target => this._runOpenAIKickoffForTarget(target, timeoutSeconds))
    );

    return {
      model: OPENAI_KICKOFF_MODEL,
      prompt: OPENAI_KICKOFF_INPUT,
      results,
    };
  }

  async _runOpenAIKickoffForTarget(target, timeoutSeconds = 30) {
    try {
      const auth = await this._ensureOpenAIAccessToken(target);
      const resolvedAccountId = auth.account_id || this._openaiAccountIdFromJWT(auth.access);
      const headers = {
        Authorization: `Bearer ${auth.access}`,
        'Content-Type': 'application/json',
        'User-Agent': 'opencode/opm',
        originator: 'opencode',
      };

      if (resolvedAccountId) {
        headers['ChatGPT-Account-Id'] = resolvedAccountId;
      }

      const response = await this._requestJson(
        OPENAI_CODEX_RESPONSES_URL,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: OPENAI_KICKOFF_MODEL,
            instructions: OPENAI_KICKOFF_INPUT,
            input: [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: OPENAI_KICKOFF_INPUT,
                  },
                ],
              },
            ],
            stream: true,
            store: false,
          }),
        },
        timeoutSeconds * 1000,
      );

      return {
        provider: 'openai',
        account_id: resolvedAccountId,
        user_id: target.user_id,
        email: target.email,
        plan_type: target.plan_type,
        nickname: target.nickname,
        presets: target.presets,
        model: OPENAI_KICKOFF_MODEL,
        output_text: extractOpenAIResponseText(response),
        error: null,
      };
    } catch (error) {
      return {
        provider: 'openai',
        account_id: target.account_id,
        user_id: target.user_id,
        email: target.email,
        plan_type: target.plan_type,
        nickname: target.nickname,
        presets: target.presets,
        model: OPENAI_KICKOFF_MODEL,
        output_text: null,
        error: t(error.opmKey || 'sync_operation_error'),
      };
    }
  }

  async _ensureOpenAIAccessToken(target) {
    let { entry } = await this._recoverOpenAI({ ...target, accountId: target.accountId || target.account_id });
    const hasFreshAccess = typeof entry.expires === 'number' && entry.expires > Date.now();
    if (entry.access && hasFreshAccess) {
      return {
        access: entry.access,
        account_id: entry.accountId,
      };
    }

    if (!target.refresh) {
      throw new Error('OpenAI token expired and no refresh token is available');
    }

    entry = await this._requestOpenAIRefresh(entry);

    return {
      access: entry.access,
      account_id: entry.accountId,
    };
  }

  async _fetchOpenAIQuotaForToken(accessToken, expires, accountId, timeoutSeconds = 10, authPlanType = null) {
    const fallbackPlanType = normalizePlanType(authPlanType);
    const nowMs = Date.now();
    if (typeof expires === 'number' && expires < nowMs) {
      return {
        provider: 'openai',
        account_id: accountId,
        daily: null,
        weekly: null,
        plan_type: fallbackPlanType,
        plan_type_source: fallbackPlanType ? 'auth' : null,
        error: 'Token expired',
      };
    }

    const resolvedAccountId = accountId || this._openaiAccountIdFromJWT(accessToken);
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'User-Agent': 'OpenCode-Quota-Toast/1.0',
    };
    if (resolvedAccountId) {
      headers['ChatGPT-Account-Id'] = resolvedAccountId;
    }

    try {
      const data = await this._requestJson(OPENAI_USAGE_URL, { headers, method: 'GET' }, timeoutSeconds * 1000);
      
      const livePlanType = normalizePlanType(data.plan_type);
      const rateLimit = data.rate_limit || {};
      const primary = rateLimit.primary_window;
      const secondary = rateLimit.secondary_window;

      let daily = null;
      if (primary && typeof primary === 'object') {
        daily = {
          percent_remaining: remainingPercent(primary),
          reset_time_iso: resetTimeIsoFromSeconds(primary.reset_at) || resetTimeIsoFromNow(primary.reset_after_seconds),
        };
      }

      let weekly = null;
      if (secondary && typeof secondary === 'object') {
        weekly = {
          percent_remaining: remainingPercent(secondary),
          reset_time_iso: resetTimeIsoFromSeconds(secondary.reset_at) || resetTimeIsoFromNow(secondary.reset_after_seconds),
        };
      }

      return {
        provider: 'openai',
        account_id: resolvedAccountId,
        daily,
        weekly,
        plan_type: livePlanType || fallbackPlanType,
        plan_type_source: livePlanType ? 'usage' : (fallbackPlanType ? 'auth' : null),
        error: null,
      };
    } catch (exc) {
      return {
        provider: 'openai',
        account_id: resolvedAccountId,
        daily: null,
        weekly: null,
        plan_type: fallbackPlanType,
        plan_type_source: fallbackPlanType ? 'auth' : null,
        error: `OpenAI API error: ${exc.message}`,
      };
    }
  }

  _openaiAccountIdFromJWT(token) {
    const payload = parseJWTPayload(token);
    if (!payload) return null;
    const authSection = payload['https://api.openai.com/auth'];
    if (authSection && typeof authSection === 'object') {
      const accountId = authSection.chatgpt_account_id;
      if (typeof accountId === 'string' && accountId) {
        return accountId;
      }
    }
    return null;
  }

  async _fetchGoogleQuotaForToken(accessToken, refreshToken, projectId, timeoutSeconds = 10) {
    let token = accessToken;

    if (!token && refreshToken) {
      token = await refreshGoogleToken(refreshToken);
    }

    if (!token) {
      return [{
        provider: 'google',
        account_id: projectId || 'unknown',
        error: 'No access token (Refresh failed)',
      }];
    }

    const actualProjectId = projectId || 'unknown-project';

    const headers = {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'antigravity/1.11.9',
      'Content-Type': 'application/json',
    };

    try {
      const data = await httpsRequest(
        GOOGLE_QUOTA_API_URL,
        { headers, method: 'POST', body: JSON.stringify({ project: actualProjectId }) },
        timeoutSeconds * 1000
      );

      const models = data.models || {};
      const results = [];

      const modelEntries = Object.entries(models);

      for (const [key, modelData] of modelEntries) {
        const quotaInfo = modelData.quotaInfo;
        if (!quotaInfo) continue;
        if (key.toLowerCase().startsWith('chat_')) continue;

        let label = modelData.displayName || key;
        const lowerKey = key.toLowerCase();

        if (lowerKey.includes('flash')) label = 'G3Flash';
        else if (lowerKey.includes('pro')) label = 'G3Pro';
        else if (lowerKey.includes('claude') && lowerKey.includes('opus')) label = 'Claude-Opus';
        else if (lowerKey.includes('claude') && lowerKey.includes('sonnet')) label = 'Claude-Sonnet';
        else if (lowerKey.includes('claude')) label = 'Claude';
        else if (lowerKey.includes('gpt') || lowerKey.includes('o1')) label = 'GPT/O1';

        const remaining = quotaInfo.remainingFraction ?? 1;
        const resetTime = quotaInfo.resetTime || null;

        results.push({
          provider: 'google',
          account_id: projectId,
          daily: {
            percent_remaining: Math.round(remaining * 100),
            reset_time_iso: resetTime,
            label,
          },
          weekly: null,
          error: null,
        });
      }

      if (results.length === 0) {
        return [{
          provider: 'google',
          account_id: projectId,
          daily: null,
          weekly: null,
          error: 'No quota info found',
        }];
      }

      return results.sort((a, b) => (a.daily?.label || '').localeCompare(b.daily?.label || ''));
    } catch (exc) {
      if (exc.message.includes('401') && refreshToken && token === accessToken) {
        const newToken = await refreshGoogleToken(refreshToken);
        if (newToken) {
          headers['Authorization'] = `Bearer ${newToken}`;
          try {
            const data = await httpsRequest(
              GOOGLE_QUOTA_API_URL,
              { headers, method: 'POST', body: JSON.stringify({ project: actualProjectId }) },
              timeoutSeconds * 1000
            );
            const models = data.models || {};
            const results = [];
            for (const [key, modelData] of Object.entries(models)) {
              const quotaInfo = modelData.quotaInfo;
              if (!quotaInfo) continue;
              let label = key;
              const lowerKey = key.toLowerCase();
              if (lowerKey.includes('flash')) label = 'G3Flash';
              else if (lowerKey.includes('pro')) label = 'G3Pro';
              else if (lowerKey.includes('claude')) label = 'Claude';
              else if (modelData.displayName) label = modelData.displayName;
              const remaining = quotaInfo.remainingFraction || 0;
              results.push({
                provider: 'google',
                account_id: projectId,
                daily: { percent_remaining: Math.round(remaining * 100), reset_time_iso: quotaInfo.resetTime, label },
                weekly: null,
                error: null,
              });
            }
            return results.length ? results : [{ provider: 'google', account_id: projectId, error: 'No quota info' }];
          } catch (exc2) {
            return [{ provider: 'google', account_id: projectId, error: `Retry failed: ${exc2.message}` }];
          }
        } else {
          return [{ provider: 'google', account_id: projectId, error: 'Token expired (Refresh failed)' }];
        }
      }
      
      return [{ provider: 'google', account_id: projectId, error: exc.message }];
    }
  }
}


export function timeUntilReset(resetTimeIso) {
  if (!resetTimeIso) return '-';

  try {
    const resetTime = new Date(resetTimeIso);
    const now = new Date();
    const deltaMs = resetTime - now;

    if (deltaMs < 0) return 'Resetting...';

    const totalSeconds = Math.floor(deltaMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (totalSeconds > 0 && hours === 0 && minutes === 0) {
      return '1m';
    }

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  } catch {
    return '-';
  }
}

function decodeBase64url(data) {
  const padding = '='.repeat((4 - data.length % 4) % 4);
  return Buffer.from(data + padding, 'base64url');
}

function parseJWTPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(decodeBase64url(parts[1]).toString('utf-8'));
    if (typeof payload === 'object') return payload;
  } catch {}
  return null;
}

function extractOpenAIResponseText(data) {
  if (!data) return null;

  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (Array.isArray(data.output)) {
    const texts = [];
    for (const item of data.output) {
      if (!item || typeof item !== 'object' || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (typeof content?.text === 'string' && content.text.trim()) {
          texts.push(content.text.trim());
        }
      }
    }

    if (texts.length > 0) {
      return texts.join(' ').trim();
    }
  }

  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.includes('data:')) {
      const deltas = [];
      for (const line of trimmed.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);

          if (typeof parsed?.delta === 'string' && parsed.delta) {
            deltas.push(parsed.delta);
          }

          if (typeof parsed?.output_text === 'string' && parsed.output_text) {
            deltas.push(parsed.output_text);
          }

          if (Array.isArray(parsed?.output)) {
            for (const item of parsed.output) {
              if (!item || typeof item !== 'object' || !Array.isArray(item.content)) continue;
              for (const content of item.content) {
                if (typeof content?.text === 'string' && content.text.trim()) {
                  deltas.push(content.text.trim());
                }
              }
            }
          }
        } catch {}
      }

      if (deltas.length > 0) {
        return deltas.join('').trim() || null;
      }
    }

    return trimmed || null;
  }

  return null;
}

function resetTimeIsoFromSeconds(resetAtSeconds) {
  if (!resetAtSeconds) return null;
  let seconds = resetAtSeconds;
  if (seconds > 100000000000) {
    seconds /= 1000;
  }
  const date = new Date(seconds * 1000);
  return date.toISOString().replace('+00:00', 'Z');
}

function resetTimeIsoFromNow(resetAfterSeconds) {
  if (!resetAfterSeconds || resetAfterSeconds <= 0) return null;
  const date = new Date(Date.now() + resetAfterSeconds * 1000);
  return date.toISOString().replace('+00:00', 'Z');
}

function remainingPercent(window) {
  const usedPercent = parseFloat(window.used_percent || 0);
  const remaining = 100 - usedPercent;
  if (remaining < 0) return 0;
  if (remaining > 100) return 100;
  return Math.round(remaining);
}

async function refreshGoogleToken(refreshToken) {
  if (!refreshToken || !ANTIGRAVITY_CLIENT_ID || !ANTIGRAVITY_CLIENT_SECRET) return null;

  const postData = new URLSearchParams({
    client_id: ANTIGRAVITY_CLIENT_ID,
    client_secret: ANTIGRAVITY_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();

  try {
    const data = await httpsRequest(
      GOOGLE_TOKEN_REFRESH_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: postData,
      },
      10000
    );
    return data.access_token;
  } catch {
    return null;
  }
}

async function refreshOpenAIToken(refreshToken, requestJson = httpsRequest) {
  if (!refreshToken) return null;

  const postData = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OPENAI_OAUTH_CLIENT_ID,
  }).toString();

  return requestJson(
    `${OPENAI_AUTH_ISSUER}/oauth/token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: postData,
    },
    10000,
  );
}

async function getAntigravityAccountsPath() {
  return findFirstExistingPath(getAntigravityAccountsPathCandidates());
}

async function extractAntigravityAccounts(path) {
  if (!path) {
    return [];
  }

  try {
    await fs.access(path);
  } catch {
    return [];
  }

  try {
    const data = JSON.parse(await fs.readFile(path, 'utf-8'));
    const accounts = data.accounts || [];
    return accounts
      .filter(acc => acc.refreshToken)
      .map(acc => ({
        refresh: acc.refreshToken,
        project_id: acc.projectId || acc.managedProjectId,
        email: acc.email,
      }));
  } catch {
    return [];
  }
}

function httpsRequest(url, options = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...options, timeout }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        } else {
          const error = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`);
          error.statusCode = res.statusCode;
          error.retryAfter = res.headers['retry-after'];
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}
