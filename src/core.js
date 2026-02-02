import { promises as fs } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import https from 'https';

const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_SECRET = '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';
const OPENAI_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const GOOGLE_QUOTA_API_URL = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';
const GOOGLE_TOKEN_REFRESH_URL = 'https://oauth2.googleapis.com/token';

const GOOGLE_MODEL_KEYS = {
  'gemini-3-pro-high': 'G3Pro',
  'gemini-3-pro-low': 'G3Pro',
  'gemini-3-flash': 'G3Flash',
  'claude-opus-4-5-thinking': 'Claude',
  'claude-opus-4-5': 'Claude',
  'gemini-3-pro-image': 'G3Image',
};

export class PresetManager {
  constructor(configDir = null) {
    this.configDir = configDir || join(homedir(), '.config', 'oauth-preset-manager');
    this.presetsDir = join(this.configDir, 'presets');
    this.backupsDir = join(this.configDir, 'backups');
    this.configFile = join(this.configDir, 'config.json');
    this.config = null;
  }

  async init() {
    await fs.mkdir(this.presetsDir, { recursive: true });
    await fs.mkdir(this.backupsDir, { recursive: true });
    this.config = await this._loadConfig();
  }

  async _loadConfig() {
    try {
      const data = await fs.readFile(this.configFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      const defaultAuthPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
      return {
        auth_path: defaultAuthPath,
        current_preset: null,
        presets: {},
      };
    }
  }

  async _saveConfig() {
    await fs.writeFile(this.configFile, JSON.stringify(this.config, null, 2));
  }

  getAuthPath() {
    return resolve(this.config.auth_path);
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

      const existing = tokenMap.get(entry.access);
      if (existing) {
        existing.presets.push(formatPresetLabel(presetName));
      } else {
        tokenMap.set(entry.access, {
          access: entry.access,
          expires: entry.expires,
          account_id: entry.account_id,
          presets: [formatPresetLabel(presetName)],
        });
      }
    }

    const results = [];
    const promises = [];

    for (const item of tokenMap.values()) {
      promises.push(
        this._fetchOpenAIQuotaForToken(item.access, item.expires, item.account_id)
          .then(result => {
            result.presets = item.presets.sort();
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
        tasks.push({
          func: this._fetchOpenAIQuotaForToken.bind(this),
          args: [openaiEntry.access, openaiEntry.expires, openaiEntry.account_id],
          presets: [activeLabel],
          accId: null,
        });
      }
    } catch {}

    const agPath = getAntigravityAccountsPath();
    for (const account of await extractAntigravityAccounts(agPath)) {
      tasks.push({
        func: this._fetchGoogleQuotaForToken.bind(this),
        args: [null, account.refresh, account.project_id],
        presets: [`(Antigravity: ${account.email || 'User'})`],
        accId: account.project_id,
      });
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
              results.push(r);
            }
          } else {
            res.presets = task.presets;
            results.push(res);
          }
        })
        .catch(() => {})
    );

    await Promise.all(promises);
    return results;
  }

  async collectAllQuota() {
    const [active, openai] = await Promise.all([
      this.collectActiveQuota(),
      this.collectOpenAIQuota(),
    ]);
    return [...active, ...openai];
  }

  _extractOpenAIOAuth(authData) {
    const entry = authData.codex || authData.openai;
    if (!entry || typeof entry !== 'object') return null;
    if (entry.type !== 'oauth') return null;
    if (!entry.access) return null;
    
    return {
      access: entry.access,
      expires: entry.expires,
      account_id: entry.accountId,
    };
  }

  async _fetchOpenAIQuotaForToken(accessToken, expires, accountId, timeoutSeconds = 10) {
    const nowMs = Date.now();
    if (typeof expires === 'number' && expires < nowMs) {
      return {
        provider: 'openai',
        account_id: accountId,
        daily: null,
        weekly: null,
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
      const data = await httpsRequest(OPENAI_USAGE_URL, { headers, method: 'GET' }, timeoutSeconds * 1000);
      
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
        error: null,
      };
    } catch (exc) {
      return {
        provider: 'openai',
        account_id: resolvedAccountId,
        daily: null,
        weekly: null,
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

      const priorityModels = [
        'gemini-3-pro-high',
        'gemini-3-pro-low', 
        'gemini-3-flash',
        'claude-opus-4-5-thinking',
        'claude-opus-4-5'
      ];
      
      const modelEntries = Object.entries(models);
      const priorityEntries = modelEntries.filter(([key]) => priorityModels.includes(key));
      const entriesToProcess = priorityEntries.length > 0 ? priorityEntries : modelEntries;

      for (const [key, modelData] of entriesToProcess) {
        const quotaInfo = modelData.quotaInfo;
        if (!quotaInfo) continue;

        let label = key;
        const lowerKey = key.toLowerCase();

        if (lowerKey.includes('flash')) label = 'G3Flash';
        else if (lowerKey.includes('pro')) label = 'G3Pro';
        else if (lowerKey.includes('claude')) label = 'Claude';
        else if (lowerKey.includes('gpt') || lowerKey.includes('o1')) label = 'GPT/O1';
        else if (modelData.displayName) label = modelData.displayName;

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
  if (!refreshToken) return null;

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

function getAntigravityAccountsPath() {
  const paths = [
    join(homedir(), '.config', 'opencode', 'antigravity-accounts.json'),
    join(homedir(), '.local', 'share', 'opencode', 'antigravity-accounts.json'),
  ];
  
  for (const p of paths) {
    try {
      fs.access(p);
      return p;
    } catch {}
  }
  return paths[0];
}

async function extractAntigravityAccounts(path) {
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
