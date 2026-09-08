import { constants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep, posix, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import TOML from '@iarna/toml';
import { t } from './i18n.js';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;

export function syncError(key) {
  return Object.assign(new Error(t(key)), { opmKey: key });
}

export function parseAuth(bytes) {
  try {
    const value = JSON.parse(utf8.decode(bytes));
    if (!object(value)) throw 0;
    return value;
  } catch { throw syncError('sync_auth_error'); }
}

export function tokenClaims(token, required = false) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part)
      || Buffer.from(part, 'base64url').toString('base64url') !== part)) throw 0;
    const header = parseAuth(Buffer.from(parts[0], 'base64url'));
    const claims = parseAuth(Buffer.from(parts[1], 'base64url'));
    if (!text(header.alg) || header.alg === 'none' || (required && !text(claims.sub))) throw 0;
    return claims;
  } catch {
    if (required) throw syncError('sync_id_error');
    return null;
  }
}

function identity(token, required = false) {
  const claims = tokenClaims(token, required);
  const auth = claims?.['https://api.openai.com/auth'];
  return { account: auth?.chatgpt_account_id || claims?.chatgpt_account_id,
    user: auth?.chatgpt_user_id || claims?.chatgpt_user_id, sub: claims?.sub };
}

export function assertIdentity(...contexts) {
  const merged = {};
  for (const key of ['account', 'user', 'sub']) {
    const values = contexts.map(context => context?.[key]).filter(value => value !== undefined && value !== null);
    if (values.some(value => !text(value)) || new Set(values).size > 1) throw syncError('sync_identity_error');
    if (values.length) merged[key] = values[0];
  }
  return merged;
}

export function entryIdentity(entry) {
  const access = identity(entry.access);
  const id = entry.id_token || entry.idToken ? identity(entry.id_token || entry.idToken, true) : {};
  if (entry.opm_identity !== undefined && !object(entry.opm_identity)) throw syncError('sync_identity_error');
  return assertIdentity(access, id, entry.opm_identity, { account: entry.accountId });
}

export function selectOpenAI(auth) {
  if (!object(auth)) throw syncError('sync_auth_error');
  const keys = ['openai', 'codex'].filter(key => auth[key]?.type === 'oauth');
  if (!keys.length) return null;
  const entry = auth[keys[0]];
  if (auth.openai && auth.codex && (keys.length !== 2 || entry.access !== auth.codex.access
    || entry.refresh !== auth.codex.refresh)) throw syncError('sync_alias_error');
  const context = assertIdentity(...keys.map(key => entryIdentity(auth[key])));
  const idToken = keys.map(key => auth[key].id_token || auth[key].idToken).find(Boolean);
  return { keys, entry: keys.length === 1 ? entry : { ...entry, opm_identity: context, ...(idToken ? { id_token: idToken } : {}) } };
}

export function parseNative(bytes) {
  const auth = parseAuth(bytes);
  const tokens = auth.tokens;
  if ((auth.auth_mode !== undefined && auth.auth_mode !== 'chatgpt')
    || (auth.OPENAI_API_KEY !== undefined && auth.OPENAI_API_KEY !== null) || !object(tokens)
    || ['id_token', 'access_token', 'refresh_token', 'account_id'].some(key => !text(tokens[key]))) {
    throw syncError('sync_auth_error');
  }
  assertIdentity(identity(tokens.id_token, true), identity(tokens.access_token), { account: tokens.account_id });
  if (auth.last_refresh !== undefined && (!text(auth.last_refresh) || !Number.isFinite(Date.parse(auth.last_refresh)))) {
    throw syncError('sync_auth_error');
  }
  return auth;
}

export function matchesNative(entry, native) {
  try {
    assertIdentity(entryIdentity(entry), identity(native.tokens.id_token, true), { account: native.tokens.account_id });
    // Exact credentials, never workspace/account ID alone: business members share IDs.
    return text(entry.access) && text(entry.refresh)
      && entry.access === native.tokens.access_token && entry.refresh === native.tokens.refresh_token;
  } catch { return false; }
}

export function nativeFromEntry(entry, idToken, lastRefresh = new Date().toISOString()) {
  const id = identity(idToken, true);
  const account = entry.accountId || entryIdentity(entry).account || id.account;
  const native = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {
    id_token: idToken, access_token: entry.access, refresh_token: entry.refresh, account_id: account,
  }, last_refresh: lastRefresh };
  parseNative(Buffer.from(JSON.stringify(native)));
  return native;
}

export function refreshedEntry(entry, response, receivedAt) {
  if (!object(response) || !text(response.access_token) || (response.refresh_token !== undefined && !text(response.refresh_token))) {
    throw syncError('sync_refresh_error');
  }
  const oldIdentity = entryIdentity(entry);
  const id = response.id_token === undefined ? {} : identity(response.id_token, true);
  const access = identity(response.access_token);
  const context = assertIdentity(oldIdentity, id, access);
  const expiresIn = Number(response.expires_in);
  const expires = expiresIn > 0 && Number.isFinite(expiresIn) ? Date.parse(receivedAt) + expiresIn * 1000
    : Number(tokenClaims(response.access_token)?.exp) * 1000;
  if (!Number.isFinite(expires) || expires <= 0) throw syncError('sync_refresh_error');
  const next = { ...entry, access: response.access_token, refresh: response.refresh_token || entry.refresh, expires, opm_identity: context };
  const account = id.account || access.account || oldIdentity.account;
  if (account) next.accountId = account;
  delete next.id_token;
  delete next.idToken;
  if (response.id_token !== undefined) next.id_token = response.id_token;
  next.last_refresh = receivedAt;
  return next;
}

export function getCodexAuthPath() {
  return join(resolve(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')), 'auth.json');
}

export function getProxyCodexAuthPath(homeDir = homedir(), platform = process.platform, environment = process.env) {
  const paths = platform === 'win32' ? win32 : posix;
  const configHome = platform === 'win32' ? environment.APPDATA?.trim() || paths.join(homeDir, 'AppData', 'Roaming')
    : platform === 'darwin' ? paths.join(homeDir, '.config') : environment.XDG_CONFIG_HOME?.trim() || paths.join(homeDir, '.config');
  const root = environment.CCP_CONFIG_DIR?.trim() || paths.join(configHome, 'claude-code-proxy');
  return paths.resolve(root, 'codex', 'auth.json');
}

export function openAIExpires(entry) {
  const exp = tokenClaims(entry.access)?.exp;
  const candidates = [entry.expires, typeof exp === 'number' ? exp * 1000 : null]
    .filter(value => Number.isFinite(value) && value > 0 && value <= 8.64e15);
  return candidates.length ? Math.min(...candidates) : null;
}

export function proxyAuthFromEntry(entry) {
  const { access, refresh, expires, accountId } = entry;
  if (!text(access) || !text(refresh) || !text(accountId) || !Number.isFinite(expires) || expires <= 0 || expires > 8.64e15) {
    throw syncError('sync_auth_error');
  }
  entryIdentity(entry);
  return { access, refresh, expires, accountId };
}

export function pathsOverlap(a, b) {
  const prefix = path => { const absolute = resolve(path); return absolute.endsWith(sep) ? absolute : absolute + sep; };
  return prefix(a).startsWith(prefix(b)) || prefix(b).startsWith(prefix(a));
}

export async function checkCodexFileStore(authPath, configDir, openCodePath, proxyPath = null) {
  if (pathsOverlap(dirname(authPath), configDir) || pathsOverlap(dirname(authPath), openCodePath)) throw syncError('sync_path_error');
  if (proxyPath !== null) {
    const proxyRoot = dirname(dirname(proxyPath));
    if ([configDir, dirname(authPath), openCodePath].some(path => pathsOverlap(proxyRoot, path))) throw syncError('sync_path_error');
    await safePath(proxyPath);
  }
  await safePath(authPath);
  const bytes = await readBytes(join(dirname(authPath), 'config.toml'));
  if (bytes === null) return;
  let config;
  try { config = TOML.parse(utf8.decode(bytes)); } catch { throw syncError('sync_store_error'); }
  const check = settings => {
    if (settings.cli_auth_credentials_store !== undefined && settings.cli_auth_credentials_store !== 'file') throw syncError('sync_store_error');
    // Inspect Codex settings/features, not unrelated MCP/env strings or project names.
    for (const area of [settings, settings.features || {}]) {
      for (const [key, value] of Object.entries(area)) {
        if (/encrypt.*secret|secret.*encrypt|secrets?_store|secrets?_backend/i.test(key)
          && value !== false && value !== 'file' && value !== 'disabled') throw syncError('sync_store_error');
      }
    }
  };
  check(config);
  for (const profile of Object.values(config.profiles || {})) if (object(profile)) check(profile);
}

// O_NOFOLLOW protects the final component; also refuse symlinked ancestors.
export async function safePath(path, directory = false) {
  path = resolve(path);
  const parent = dirname(path);
  if (parent !== path) await safePath(parent, true);
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw syncError('sync_path_error');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function readBytes(path) {
  await safePath(path);
  let file;
  try {
    file = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw syncError('sync_path_error');
    return await file.readFile();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { await file?.close(); }
}

export async function privateDir(path) {
  await safePath(path, true);
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  await fs.chmod(path, 0o700);
}

export async function writeBytesAtomic(path, bytes) {
  await safePath(path);
  await privateDir(dirname(path));
  const tmp = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await fs.open(tmp, 'wx', 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = null;
    await safePath(path);
    await fs.rename(tmp, path);
  } finally {
    await file?.close();
    await fs.unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
