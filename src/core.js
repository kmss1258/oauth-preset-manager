import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import https from 'https';
import { env } from 'process';

const ANTIGRAVITY_CLIENT_ID = env.OPM_ANTIGRAVITY_CLIENT_ID?.trim() || '';
const ANTIGRAVITY_CLIENT_SECRET = env.OPM_ANTIGRAVITY_CLIENT_SECRET?.trim() || '';
const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_AUTH_ISSUER = 'https://auth.openai.com';
const OPENAI_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const OPENAI_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const GOOGLE_QUOTA_API_URL = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const GOOGLE_TOKEN_REFRESH_URL = 'https://oauth2.googleapis.com/token';
const OPENAI_KICKOFF_MODEL = 'gpt-5.4-mini';
const OPENAI_KICKOFF_INPUT = 'Reply with exactly OK.';

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
    this.configDir = configDir || join(homedir(), '.config', 'oauth-preset-manager');
    this.presetsDir = join(this.configDir, 'presets');
    this.backupsDir = join(this.configDir, 'backups');
    this.configFile = join(this.configDir, 'config.json');
    this.quotaCacheFile = join(this.configDir, 'quota-cache.json');
    this.openCodeGoConfigFile = join(this.configDir, 'opencode-go.json');
    this.config = null;
    this.quotaCache = this._createEmptyQuotaCache();
    this.lastOpenAIRefreshResults = [];
    this._requestJson = httpsRequest;
  }

  async init() {
    await fs.mkdir(this.presetsDir, { recursive: true });
    await fs.mkdir(this.backupsDir, { recursive: true });
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
    try {
      const data = await fs.readFile(this.configFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      const defaultAuthPath = this.getSuggestedAuthPath();
      return {
        auth_path: defaultAuthPath,
        current_preset: null,
        presets: {},
      };
    }
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
    await fs.writeFile(this.configFile, JSON.stringify(this.config, null, 2));
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

  async _createBackup(name = null) {
    const authPath = this.getAuthPath();
    try {
      await fs.access(authPath);
    } catch {
      return null;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const backupName = name || `backup_${timestamp}.json`;
    const backupPath = join(this.backupsDir, backupName);

    await fs.copyFile(authPath, backupPath);

    try {
      const files = await fs.readdir(this.backupsDir);
      const backups = files
        .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
        .map(f => ({ name: f, path: join(this.backupsDir, f) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      
      if (backups.length > 10) {
        for (const old of backups.slice(0, backups.length - 10)) {
          await fs.unlink(old.path);
        }
      }
    } catch {}

    return backupPath;
  }

  async savePreset(name, description = '', watchedServices = null) {
    const authPath = this.getAuthPath();
    
    try {
      await fs.access(authPath);
    } catch {
      throw new Error(`Auth file not found: ${authPath}`);
    }

    const authData = JSON.parse(await fs.readFile(authPath, 'utf-8'));
    const presetPath = join(this.presetsDir, `${name}.json`);
    await fs.copyFile(authPath, presetPath);

    const services = Object.keys(authData);
    const now = new Date().toISOString();

    if (watchedServices === null) {
      watchedServices = ['openai'];
    }

    this.config.presets[name] = {
      created_at: now,
      last_used: now,
      description,
      services,
      watched_services: watchedServices,
    };
    this.config.current_preset = name;
    await this._saveConfig();

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
    const presetPath = join(this.presetsDir, `${name}.json`);
    
    try {
      await fs.access(presetPath);
    } catch {
      throw new Error(`Preset not found: ${name}`);
    }

    const authPath = this.getAuthPath();

    // Read old and new auth data
    let oldAuth = {};
    try {
      await fs.access(authPath);
      oldAuth = JSON.parse(await fs.readFile(authPath, 'utf-8'));
    } catch {}

    const newAuth = JSON.parse(await fs.readFile(presetPath, 'utf-8'));
    const diff = this._computeAuthDiff(oldAuth, newAuth);

    let backupPath = null;
    if (autoBackup) {
      try {
        await fs.access(authPath);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
        backupPath = await this._createBackup(`before_${name}_${timestamp}.json`);
      } catch {}
    }

    await fs.mkdir(dirname(authPath), { recursive: true });
    await fs.copyFile(presetPath, authPath);

    const now = new Date().toISOString();
    if (this.config.presets[name]) {
      this.config.presets[name].last_used = now;
    }
    this.config.current_preset = name;
    await this._saveConfig();

    return {
      success: true,
      preset_name: name,
      source_path: presetPath,
      destination_path: authPath,
      backup_path: backupPath,
      diff,
    };
  }

  async overwritePresetFromCurrent(name, autoBackup = true) {
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

    let backupPath = null;
    if (autoBackup) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      backupPath = join(this.backupsDir, `preset_${name}_${timestamp}.json`);
      await fs.copyFile(presetPath, backupPath);
    }

    await fs.copyFile(authPath, presetPath);

    const now = new Date().toISOString();
    if (this.config.presets[name]) {
      this.config.presets[name].last_used = now;
    }
    this.config.current_preset = name;
    await this._saveConfig();

    return {
      success: true,
      preset_name: name,
      preset_path: presetPath,
      backup_path: backupPath,
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
    const presetPath = join(this.presetsDir, `${name}.json`);
    
    try {
      await fs.access(presetPath);
    } catch {
      throw new Error(`Preset not found: ${name}`);
    }

    await fs.unlink(presetPath);

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
      currentAuth = JSON.parse(await fs.readFile(authPath, 'utf-8'));
    } catch {
      return null;
    }

    const files = await fs.readdir(this.presetsDir).catch(() => []);
    
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const presetAuth = JSON.parse(await fs.readFile(join(this.presetsDir, file), 'utf-8'));
        if (JSON.stringify(currentAuth) === JSON.stringify(presetAuth)) {
          return file.slice(0, -5);
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
        try {
          const data = JSON.parse(await fs.readFile(join(this.presetsDir, file), 'utf-8'));
          if (typeof data === 'object' && data !== null) {
            results.push([name, data]);
          }
        } catch {}
      }
    } catch {}

    return results;
  }

  async _writeJsonAtomic(path, data) {
    const tmpPath = `${path}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      await fs.rename(tmpPath, path);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => {});
      throw error;
    }
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

    const records = (await Promise.all(targets.map(async target => {
      try {
        const data = JSON.parse(await fs.readFile(target.path, 'utf-8'));
        const service = data.codex ? 'codex' : data.openai ? 'openai' : null;
        const entry = service ? data[service] : null;
        if (
          !entry
          || entry.type !== 'oauth'
          || typeof entry.expires !== 'number'
          || entry.expires > Date.now()
        ) {
          return null;
        }
        return { ...target, data, service, entry };
      } catch {
        return null;
      }
    }))).filter(Boolean);

    const makeResult = (record, success, error = null) => ({
      preset_name: record.preset_name,
      is_active: record.is_active,
      success,
      error,
    });
    const results = [];
    const groups = new Map();

    for (const record of records) {
      if (typeof record.entry.refresh !== 'string' || !record.entry.refresh) {
        results.push(makeResult(record, false, 'No refresh token is available'));
        continue;
      }

      const group = groups.get(record.entry.refresh) || [];
      group.push(record);
      groups.set(record.entry.refresh, group);
    }

    const groupResults = await Promise.all(Array.from(groups.entries()).map(async ([refresh, group]) => {
      let tokens;
      try {
        tokens = await refreshOpenAIToken(refresh, this._requestJson);
      } catch (error) {
        return group.map(record => makeResult(record, false, error.message));
      }

      const access = tokens?.access_token;
      const expiresIn = Number(tokens?.expires_in);
      const jwtExpires = Number(parseJWTPayload(access || '')?.exp);
      const expires = Number.isFinite(expiresIn) && expiresIn > 0
        ? Date.now() + expiresIn * 1000
        : Number.isFinite(jwtExpires) && jwtExpires > 0
          ? jwtExpires * 1000
          : null;

      if (!access || !expires) {
        return group.map(record => makeResult(record, false, 'OAuth response did not include a usable access token'));
      }

      const accountId = extractAccountIdFromTokenSet(tokens);
      return Promise.all(group.map(async record => {
        try {
          record.data[record.service] = {
            ...record.entry,
            access,
            refresh: tokens.refresh_token || refresh,
            expires,
            ...(accountId ? { accountId } : {}),
          };
          await this._writeJsonAtomic(record.path, record.data);
          return makeResult(record, true);
        } catch (error) {
          return makeResult(record, false, `Failed to save refreshed token: ${error.message}`);
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

    const [active, openai, opencodego] = await Promise.all([
      this.collectActiveQuota(),
      this.collectOpenAIQuota(),
      this.collectOpenCodeGoQuota(),
    ]);
    return [...active, ...openai, ...opencodego];
  }

  async _getOpenCodeGoCredentials() {
    let config = {};
    try {
      const parsed = JSON.parse(await fs.readFile(this.openCodeGoConfigFile, 'utf-8'));
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

  _extractOpenAIOAuth(authData) {
    const entry = authData.codex || authData.openai;
    if (!entry || typeof entry !== 'object') return null;
    if (entry.type !== 'oauth') return null;
    if (!entry.access) return null;
    
    return {
      access: entry.access,
      refresh: entry.refresh,
      expires: entry.expires,
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

    const addTarget = (entry, label, nickname = null) => {
      if (!entry?.access) return;

      const key = entry.refresh || entry.access;
      const identity = this._extractOpenAIIdentity(entry.access, entry.account_id);
      const resolvedAccountId = identity.account_id || entry.account_id || null;
      const existing = tokenMap.get(key);

      if (existing) {
        existing.labels.add(label);
        if (!existing.nickname && nickname) {
          existing.nickname = nickname;
        }
        return;
      }

      tokenMap.set(key, {
        access: entry.access,
        refresh: entry.refresh,
        expires: entry.expires,
        account_id: resolvedAccountId,
        user_id: identity.user_id,
        email: identity.email,
        plan_type: identity.plan_type,
        labels: new Set([label]),
        nickname: nickname || identity.email || null,
      });
    };

    const authPath = this.getAuthPath();
    try {
      await fs.access(authPath);
      const authData = JSON.parse(await fs.readFile(authPath, 'utf-8'));
      const entry = this._extractOpenAIOAuth(authData);
      let displayPath = authPath;
      try {
        displayPath = authPath.replace(homedir(), '~');
      } catch {}
      addTarget(entry, `(Current Active: ${displayPath})`, null);
    } catch {}

    const presetData = await this.listPresetAuthData();
    for (const [presetName, authData] of presetData) {
      const entry = this._extractOpenAIOAuth(authData);
      if (!entry) continue;
      const display = join(this.presetsDir, `${presetName}.json`).replace(homedir(), '~');
      addTarget(entry, `${presetName} (${display})`, presetName);
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
        error: error.message,
      };
    }
  }

  async _ensureOpenAIAccessToken(target) {
    const hasFreshAccess = typeof target.expires === 'number' && target.expires > Date.now();
    if (target.access && hasFreshAccess) {
      return {
        access: target.access,
        account_id: target.account_id,
      };
    }

    if (!target.refresh) {
      throw new Error('OpenAI token expired and no refresh token is available');
    }

    const tokens = await refreshOpenAIToken(target.refresh, this._requestJson);
    if (!tokens?.access_token) {
      throw new Error('OpenAI token refresh failed');
    }

    return {
      access: tokens.access_token,
      account_id: extractAccountIdFromTokenSet(tokens) || target.account_id,
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

function extractAccountIdFromTokenSet(tokens) {
  const idTokenClaims = typeof tokens?.id_token === 'string' ? parseJWTPayload(tokens.id_token) : null;
  const accessTokenClaims = typeof tokens?.access_token === 'string' ? parseJWTPayload(tokens.access_token) : null;
  const claims = idTokenClaims || accessTokenClaims;
  const authSection = claims?.['https://api.openai.com/auth'];

  if (typeof claims?.chatgpt_account_id === 'string' && claims.chatgpt_account_id) {
    return claims.chatgpt_account_id;
  }

  if (typeof authSection?.chatgpt_account_id === 'string' && authSection.chatgpt_account_id) {
    return authSection.chatgpt_account_id;
  }

  const organizations = claims?.organizations;
  if (Array.isArray(organizations) && typeof organizations[0]?.id === 'string') {
    return organizations[0].id;
  }

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
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
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
