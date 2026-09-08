import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { PresetManager } from '../src/core.js';
import { checkCodexFileStore, getCodexAuthPath, getProxyCodexAuthPath, parseNative, proxyAuthFromEntry } from '../src/codex.js';
import { buildInteractiveChoices, cmdSwitch, enableEscToExit, interactiveMode } from '../src/cli.js';
import { setLanguage, t } from '../src/i18n.js';

// Offline fixtures only. No production path creates or signs ID tokens.
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = claims => `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.dGVzdC1zaWduYXR1cmU`;
function native(user = 'one', generation = 'initial', account = 'shared-workspace') {
  return { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {
    id_token: jwt({ sub: user, 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_user_id: user } }),
    access_token: `TEST-access-${user}-${generation}`, refresh_token: `TEST-refresh-${user}-${generation}`, account_id: account,
  }, last_refresh: '2026-09-08T00:00:00Z', metadata: { preserve: 'original bytes' } };
}
const bytes = value => Buffer.from(JSON.stringify(value, null, 3) + '\n');
function auth(bundle, inline = false, alias = 'openai') {
  return { [alias]: { type: 'oauth', access: bundle.tokens.access_token, refresh: bundle.tokens.refresh_token,
    accountId: bundle.tokens.account_id, expires: Date.now() + 3600_000,
    ...(inline ? { id_token: bundle.tokens.id_token, last_refresh: bundle.last_refresh } : {}) },
  anthropic: { type: 'api', key: 'TEST-preserve-unrelated' } };
}
const response = bundle => ({ ...bundle.tokens, expires_in: 3600 });
const errorKey = key => error => error.opmKey === key;
async function setup(context, { bundle = native(), inline = false, nativeFile = true } = {}) {
  const dir = await fs.mkdtemp(join(tmpdir(), 'opm-dual-'));
  const overrides = { HOME: dir, CODEX_HOME: join(dir, '.codex'), CCP_CONFIG_DIR: join(dir, 'claude-code-proxy'),
    OPM_AUTH_PATH: join(dir, 'opencode', 'auth.json') };
  const previousEnv = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const previousExit = process.exitCode;
  context.after(async () => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    process.exitCode = previousExit;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const manager = new PresetManager(join(dir, 'opm'));
  manager._requestJson = async () => assert.fail('Unexpected network request');
  await fs.mkdir(dirname(overrides.OPM_AUTH_PATH));
  await fs.writeFile(overrides.OPM_AUTH_PATH, bytes(auth(bundle, inline)));
  if (nativeFile) {
    await fs.mkdir(overrides.CODEX_HOME);
    await fs.writeFile(getCodexAuthPath(), bytes(bundle));
  }
  await manager.init();
  return { dir, manager, bundle, preset: name => join(manager.presetsDir, `${name}.json`), codexPath: getCodexAuthPath(), proxyPath: getProxyCodexAuthPath() };
}
async function snapshot(manager, name = 'work') {
  const paths = [manager.getAuthPath(), getCodexAuthPath(), getProxyCodexAuthPath(), manager.configFile, manager.openCodeGoConfigFile,
    join(manager.presetsDir, `${name}.json`), manager._codexSidecarPath(name)];
  return new Map(await Promise.all(paths.map(async path => [path, await fs.readFile(path).catch(error => {
    if (error.code === 'ENOENT') return null; throw error;
  })])));
}
async function unchanged(before) {
  for (const [path, value] of before) assert.deepEqual(await fs.readFile(path).catch(error => {
    if (error.code === 'ENOENT') return null; throw error;
  }), value, path);
}

test('normal switch installs one account in three destinations, preserving native bytes and private flat proxy auth', async context => {
  const { manager, bundle, codexPath, proxyPath, preset } = await setup(context, { inline: true });
  const original = await fs.readFile(codexPath);
  await manager.savePreset('work');
  await assert.rejects(fs.stat(proxyPath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(manager._codexSidecarPath('work')), original);
  const other = native('other');
  await fs.writeFile(codexPath, bytes(other));
  await fs.writeFile(manager.getAuthPath(), bytes(auth(other)));
  const result = await manager.switchPreset('work');
  assert.equal(result.codex_synced, true);
  assert.equal(result.proxy_synced, true);
  assert.equal(result.proxy_path, proxyPath);
  assert.deepEqual(await fs.readFile(codexPath), original);
  const active = JSON.parse(await fs.readFile(manager.getAuthPath()));
  const proxy = JSON.parse(await fs.readFile(proxyPath));
  assert.deepEqual(proxy, { access: active.openai.access, refresh: active.openai.refresh, expires: active.openai.expires, accountId: active.openai.accountId });
  assert.deepEqual(Object.keys(proxy).sort(), ['access', 'accountId', 'expires', 'refresh']);
  assert.equal(active.openai.access, bundle.tokens.access_token);
  assert.deepEqual(active.anthropic, auth(bundle).anthropic);
  assert.deepEqual(await fs.readFile(manager.getAuthPath()), await fs.readFile(preset('work')));
  assert.equal(await manager.detectCurrentPreset(), 'work');
  for (const path of [manager.getAuthPath(), codexPath, proxyPath, preset('work'), manager._codexSidecarPath('work'), manager.configFile]) {
    assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  }
  for (const path of [manager.configDir, manager.presetsDir, manager.codexSidecarsDir, dirname(codexPath), dirname(proxyPath), dirname(dirname(proxyPath)), manager.backupsDir]) {
    assert.equal((await fs.stat(path)).mode & 0o777, 0o700);
  }
  const backups = await fs.readdir(manager.backupsDir);
  assert.ok(backups.length >= 4);
  assert.ok((await Promise.all(backups.map(file => fs.readFile(join(manager.backupsDir, file))))).some(value => value.equals(bytes(other))));
});

test('legacy preset hydrates through injected OAuth refresh and saves genuine returned bundle before writes', async context => {
  const { manager, bundle, preset, codexPath } = await setup(context, { nativeFile: false });
  await manager.savePreset('work');
  const before = await snapshot(manager);
  const refreshed = native('one', 'rotated');
  let calls = 0;
  manager._requestJson = async (url, options) => {
    calls++;
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(form.get('refresh_token'), bundle.tokens.refresh_token);
    await unchanged(before);
    return response(refreshed);
  };
  const write = manager._writeBytesAtomic.bind(manager);
  manager._writeBytesAtomic = async (path, data) => {
    if (path === manager.getAuthPath()) {
      const log = JSON.parse(await fs.readFile(manager._recoveryPath(bundle.tokens.refresh_token)));
      assert.equal(log.status, 'received');
      assert.equal(log.response.id_token, refreshed.tokens.id_token);
      assert.equal(log.response.refresh_token, refreshed.tokens.refresh_token);
    }
    return write(path, data);
  };
  await manager.switchPreset('work');
  assert.equal(calls, 1);
  for (const path of [preset('work'), manager.getAuthPath()]) {
    const value = JSON.parse(await fs.readFile(path)).openai;
    assert.equal(value.access, refreshed.tokens.access_token);
    assert.equal(value.refresh, refreshed.tokens.refresh_token);
    assert.equal(value.accountId, refreshed.tokens.account_id);
    assert.ok(value.expires > Date.now());
  }
  assert.equal(parseNative(await fs.readFile(codexPath)).tokens.id_token, refreshed.tokens.id_token);
  await manager.switchPreset('work');
  assert.equal(calls, 1, 'current retained bundle must not refresh again');
});

test('inline genuine ID works with opaque access tokens and creates Codex only on switch', async context => {
  const { manager, codexPath, bundle } = await setup(context, { inline: true, nativeFile: false });
  await manager.savePreset('work');
  await assert.rejects(fs.stat(dirname(codexPath)), { code: 'ENOENT' });
  await manager.switchPreset('work');
  assert.equal(parseNative(await fs.readFile(codexPath)).tokens.id_token, bundle.tokens.id_token);
});

test('proxy path resolver honors CCP_CONFIG_DIR and platform-specific config roots', () => {
  assert.equal(getProxyCodexAuthPath('/home/test', 'linux', {}), '/home/test/.config/claude-code-proxy/codex/auth.json');
  assert.equal(getProxyCodexAuthPath('/home/test', 'linux', { XDG_CONFIG_HOME: '/xdg' }), '/xdg/claude-code-proxy/codex/auth.json');
  assert.equal(getProxyCodexAuthPath('/home/test', 'linux', { CCP_CONFIG_DIR: '  /custom/proxy  ', XDG_CONFIG_HOME: '/xdg' }), '/custom/proxy/codex/auth.json');
  assert.equal(getProxyCodexAuthPath('/home/test', 'linux', { CCP_CONFIG_DIR: ' ', XDG_CONFIG_HOME: '/xdg' }), '/xdg/claude-code-proxy/codex/auth.json');
  assert.equal(getProxyCodexAuthPath('/Users/test', 'darwin', { XDG_CONFIG_HOME: '/ignored' }), '/Users/test/.config/claude-code-proxy/codex/auth.json');
  assert.equal(getProxyCodexAuthPath('/Users/test', 'darwin', { CCP_CONFIG_DIR: '/profiles/proxy' }), '/profiles/proxy/codex/auth.json');
  assert.equal(getProxyCodexAuthPath('C:\\Users\\test', 'win32', { APPDATA: 'C:\\Roaming', XDG_CONFIG_HOME: 'D:\\ignored' }), 'C:\\Roaming\\claude-code-proxy\\codex\\auth.json');
  assert.equal(getProxyCodexAuthPath('C:\\Users\\test', 'win32', { APPDATA: 'C:\\Roaming', CCP_CONFIG_DIR: 'D:\\proxy' }), 'D:\\proxy\\codex\\auth.json');
});

test('proxy expiry is derived only from access JWT exp and retained identically in OpenCode and preset', async context => {
  const bundle = native('one', 'jwt-expiry');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  bundle.tokens.access_token = jwt({ sub: 'one', exp, 'https://api.openai.com/auth': { chatgpt_account_id: bundle.tokens.account_id, chatgpt_user_id: 'one' } });
  const { manager, proxyPath, preset } = await setup(context, { bundle });
  const source = auth(bundle);
  delete source.openai.expires;
  await fs.writeFile(manager.getAuthPath(), bytes(source));
  await manager.savePreset('work');
  await manager.switchPreset('work');
  for (const path of [manager.getAuthPath(), preset('work')]) {
    assert.equal(JSON.parse(await fs.readFile(path)).openai.expires, exp * 1000);
  }
  assert.equal(JSON.parse(await fs.readFile(proxyPath)).expires, exp * 1000);
});

test('missing or unusable opaque-token expiry forces refresh; native ID expiry is never substituted', async context => {
  const { manager, proxyPath, preset } = await setup(context, { nativeFile: false });
  let calls = 0;
  for (const [index, expires] of [undefined, null, '9999999999999', 0, -1, 1e30].entries()) {
    const bundle = native('one', `expiry-${index}`);
    bundle.tokens.id_token = jwt({ sub: 'one', exp: Math.floor(Date.now() / 1000) + 86400,
      'https://api.openai.com/auth': { chatgpt_account_id: bundle.tokens.account_id, chatgpt_user_id: 'one' } });
    const source = auth(bundle, true);
    source.openai.expires = expires;
    await fs.writeFile(manager.getAuthPath(), bytes(source));
    await manager.savePreset('work');
    const refreshed = native('one', `expiry-refreshed-${index}`);
    manager._requestJson = async () => { calls++; return response(refreshed); };
    await manager.switchPreset('work');
    const installed = JSON.parse(await fs.readFile(preset('work'))).openai;
    assert.ok(installed.expires > Date.now());
    assert.deepEqual(JSON.parse(await fs.readFile(proxyPath)), proxyAuthFromEntry(installed));
    assert.equal(installed.access, refreshed.tokens.access_token);
  }
  assert.equal(calls, 6);
});

test('refresh without usable access expiry fails before all three writes and retains recovery', async context => {
  const { manager, bundle } = await setup(context, { inline: true });
  const source = auth(bundle, true);
  delete source.openai.expires;
  await fs.writeFile(manager.getAuthPath(), bytes(source));
  await manager.savePreset('work');
  const before = await snapshot(manager);
  const refreshed = response(native('one', 'no-expiry'));
  delete refreshed.expires_in;
  manager._requestJson = async () => refreshed;
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_recovery_error'));
  await unchanged(before);
  assert.equal(JSON.parse(await fs.readFile(manager._recoveryPath(bundle.tokens.refresh_token))).response.refresh_token, refreshed.refresh_token);
});

test('third destination failure restores both apps and proxy, then recovers rotation without a second grant', async context => {
  const { manager, bundle, codexPath, proxyPath, preset } = await setup(context);
  await manager.savePreset('work');
  const source = JSON.parse(await fs.readFile(preset('work')));
  source.openai.expires = Date.now() - 1;
  await fs.writeFile(preset('work'), bytes(source));
  const other = native('other');
  await fs.writeFile(manager.getAuthPath(), bytes(auth(other)));
  await fs.writeFile(codexPath, bytes(other));
  await fs.mkdir(dirname(proxyPath), { recursive: true });
  await fs.writeFile(proxyPath, bytes(proxyAuthFromEntry(auth(other).openai)));
  const proxyRoot = dirname(dirname(proxyPath));
  const untouched = [join(proxyRoot, 'anthropic', 'auth.json'), join(proxyRoot, 'gemini', 'auth.json'), join(proxyRoot, 'config.toml')];
  for (const path of untouched) {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, 'TEST-unrelated-provider');
  }
  const before = await snapshot(manager);
  const refreshed = native('one', 'third-target');
  let calls = 0;
  manager._requestJson = async () => { calls++; return response(refreshed); };
  const write = manager._writeBytesAtomic.bind(manager);
  let failed = false;
  manager._writeBytesAtomic = async (path, data) => {
    if (path === proxyPath && !failed) {
      failed = true;
      assert.equal(JSON.parse(await fs.readFile(manager.getAuthPath())).openai.access, refreshed.tokens.access_token);
      assert.equal(parseNative(await fs.readFile(codexPath)).tokens.access_token, refreshed.tokens.access_token);
      throw new Error('TEST-third-destination-write');
    }
    return write(path, data);
  };
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_rotated_error'));
  await unchanged(before);
  assert.equal(JSON.parse(await fs.readFile(manager._recoveryPath(bundle.tokens.refresh_token))).response.refresh_token, refreshed.tokens.refresh_token);
  await manager.switchPreset('work');
  assert.equal(calls, 1);
  const installed = JSON.parse(await fs.readFile(manager.getAuthPath())).openai;
  assert.deepEqual(JSON.parse(await fs.readFile(proxyPath)), proxyAuthFromEntry(installed));
  for (const path of untouched) assert.equal(await fs.readFile(path, 'utf8'), 'TEST-unrelated-provider');
});

test('proxy backup failure aborts before refresh or any target replacement', async context => {
  const { manager, proxyPath, preset } = await setup(context);
  await manager.savePreset('work');
  const source = JSON.parse(await fs.readFile(preset('work')));
  source.openai.expires = Date.now() - 1;
  await fs.writeFile(preset('work'), bytes(source));
  await fs.mkdir(dirname(proxyPath), { recursive: true });
  const originalProxy = Buffer.from('TEST-proxy-backup-required');
  await fs.writeFile(proxyPath, originalProxy);
  const before = await snapshot(manager);
  const backup = manager._writePrivateBackup.bind(manager);
  manager._writePrivateBackup = async (prefix, data) => {
    if (data.equals(originalProxy)) throw new Error('TEST-proxy-backup-failure');
    return backup(prefix, data);
  };
  await assert.rejects(manager.switchPreset('work'), /TEST-proxy-backup-failure/);
  await unchanged(before);
});

test('proxy overrides never fall back after failure and mutually overlapping auth roots are rejected', async context => {
  const { manager, dir, codexPath, proxyPath } = await setup(context);
  await manager.savePreset('work');
  const originalRoot = process.env.CCP_CONFIG_DIR;
  const isolated = join(dir, 'isolated-proxy');
  process.env.CCP_CONFIG_DIR = `  ${isolated}  `;
  await manager.switchPreset('work');
  assert.ok(await fs.stat(join(isolated, 'codex', 'auth.json')));
  await assert.rejects(fs.stat(proxyPath), { code: 'ENOENT' });
  const invalid = join(dir, 'not-a-directory');
  await fs.writeFile(invalid, 'TEST-invalid-root');
  process.env.CCP_CONFIG_DIR = invalid;
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_path_error'));
  await assert.rejects(fs.stat(proxyPath), { code: 'ENOENT' });
  for (const root of [manager.configDir, manager.presetsDir, manager.codexSidecarsDir, manager.refreshRecoveryDir,
    dirname(codexPath), dirname(manager.getAuthPath()), dir]) {
    process.env.CCP_CONFIG_DIR = root;
    await assert.rejects(manager.switchPreset('work'), errorKey('sync_path_error'));
  }
  process.env.CCP_CONFIG_DIR = originalRoot;
  const originalCodePath = process.env.OPM_AUTH_PATH;
  process.env.OPM_AUTH_PATH = join(originalRoot, 'anthropic', 'auth.json');
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_path_error'));
  process.env.OPM_AUTH_PATH = originalCodePath;
  process.env.CODEX_HOME = join(originalRoot, 'codex');
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_path_error'));
});

test('save/overwrite never pairs a different business member by shared workspace ID', async context => {
  const { manager, bundle, codexPath } = await setup(context);
  await fs.writeFile(codexPath, bytes(native('different-member')));
  await manager.savePreset('work');
  await assert.rejects(fs.stat(manager._codexSidecarPath('work')), { code: 'ENOENT' });
  await manager.overwritePresetFromCurrent('work');
  await assert.rejects(fs.stat(manager._codexSidecarPath('work')), { code: 'ENOENT' });
  let calls = 0;
  manager._requestJson = async () => { calls++; return response(native('one', 'rotated')); };
  await manager.switchPreset('work');
  assert.equal(calls, 1);
  const active = parseNative(await fs.readFile(codexPath));
  assert.equal(active.tokens.id_token, bundle.tokens.id_token);
  assert.notEqual(active.tokens.id_token, native('different-member').tokens.id_token);
});

test('save retains only exact current token linkage; stale links disappear on overwrite', async context => {
  const { manager, codexPath } = await setup(context);
  await manager.savePreset('work');
  const next = native('one', 'new-login');
  await fs.writeFile(manager.getAuthPath(), bytes(auth(next)));
  await manager.overwritePresetFromCurrent('work');
  await assert.rejects(fs.stat(manager._codexSidecarPath('work')), { code: 'ENOENT' });
  await fs.writeFile(codexPath, bytes(next));
  await manager.savePreset('work');
  assert.deepEqual(await fs.readFile(manager._codexSidecarPath('work')), bytes(next));
});

test('both OAuth aliases are updated consistently and conflicting aliases fail before refresh/writes', async context => {
  const { manager, bundle, preset } = await setup(context);
  let data = auth(bundle, false, 'codex');
  await fs.writeFile(manager.getAuthPath(), bytes(data));
  await manager.savePreset('alias');
  await manager.switchPreset('alias');
  assert.equal(JSON.parse(await fs.readFile(manager.getAuthPath())).codex.access, bundle.tokens.access_token);
  data.openai = { ...data.codex };
  await fs.writeFile(manager.getAuthPath(), bytes(data));
  await manager.savePreset('work');
  await manager.switchPreset('work');
  const installed = JSON.parse(await fs.readFile(manager.getAuthPath()));
  assert.equal(installed.openai.refresh, installed.codex.refresh);
  for (const other of [auth(native('other')).openai, { type: 'api', key: 'TEST-api' }]) {
    await fs.writeFile(preset('work'), bytes({ ...data, codex: other }));
    const before = await snapshot(manager);
    await assert.rejects(manager.switchPreset('work'), errorKey('sync_alias_error'));
    await unchanged(before);
  }
});

test('refresh missing ID or conflicting identity keeps targets unchanged and records returned rotation', async context => {
  const { manager, bundle, preset } = await setup(context, { nativeFile: false });
  const withIdentity = auth(bundle);
  withIdentity.openai.access = jwt({ sub: 'one', 'https://api.openai.com/auth': { chatgpt_account_id: 'shared-workspace', chatgpt_user_id: 'one' } });
  await fs.writeFile(manager.getAuthPath(), bytes(withIdentity));
  await manager.savePreset('work');
  const before = await snapshot(manager);
  for (const kind of ['missing-id', 'wrong-user', 'wrong-workspace', 'malformed-id']) {
    const fresh = native(kind === 'wrong-user' ? 'another' : 'one', kind, kind === 'wrong-workspace' ? 'different-workspace' : 'shared-workspace');
    const result = response(fresh);
    if (kind === 'missing-id') delete result.id_token;
    if (kind === 'malformed-id') result.id_token = 'TEST-not-a-JWT';
    manager._requestJson = async () => result;
    await assert.rejects(manager.switchPreset('work'), errorKey('sync_recovery_error'));
    await unchanged(before);
    const path = manager._recoveryPath(bundle.tokens.refresh_token);
    assert.equal(JSON.parse(await fs.readFile(path)).response.refresh_token, result.refresh_token);
    assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
    await fs.unlink(path); // Test isolation only, not the production recovery workflow.
  }
  assert.deepEqual(await fs.readFile(preset('work')), before.get(preset('work')));
});

test('refresh transport failure is redacted, fails before targets, and prevents blind reuse', async context => {
  const { manager, bundle } = await setup(context, { nativeFile: false });
  await manager.savePreset('work');
  const before = await snapshot(manager);
  let calls = 0;
  manager._requestJson = async () => { calls++; throw new Error('TEST-SECRET-response-body'); };
  await assert.rejects(manager.switchPreset('work'), error => {
    assert.equal(error.opmKey, 'sync_refresh_uncertain');
    assert.doesNotMatch(error.message, /TEST-SECRET/);
    return true;
  });
  await unchanged(before);
  assert.equal(JSON.parse(await fs.readFile(manager._recoveryPath(bundle.tokens.refresh_token))).status, 'pending');
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_recovery_error'));
  assert.equal(calls, 1);
});

test('known sidecar user identity constrains refresh even with opaque access and a shared workspace', async context => {
  const { manager, preset } = await setup(context);
  await manager.savePreset('work');
  const expired = JSON.parse(await fs.readFile(preset('work')));
  expired.openai.expires = Date.now() - 1;
  await fs.writeFile(preset('work'), bytes(expired));
  const before = await snapshot(manager);
  manager._requestJson = async () => response(native('wrong-member', 'rotated'));
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_recovery_error'));
  await unchanged(before);
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_recovery_error'));
});

test('secondary alias identity is retained for hydration and rejects conflicting refresh user claims', async context => {
  const { manager, bundle, preset } = await setup(context, { nativeFile: false });
  const source = auth(bundle);
  source.openai.id_token = jwt({ sub: 'same-sub', 'https://api.openai.com/auth': { chatgpt_account_id: 'shared-workspace' } });
  source.openai.expires = Date.now() - 1;
  source.codex = { ...source.openai, opm_identity: { user: 'known-user' } };
  await fs.writeFile(manager.getAuthPath(), bytes(source));
  await manager.savePreset('work');
  const before = await snapshot(manager);
  const changed = response(native('one', 'changed'));
  changed.id_token = jwt({ sub: 'same-sub', 'https://api.openai.com/auth': { chatgpt_account_id: 'shared-workspace', chatgpt_user_id: 'wrong-user' } });
  manager._requestJson = async () => changed;
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_recovery_error'));
  await unchanged(before);
  assert.equal(JSON.parse(await fs.readFile(preset('work'))).codex.opm_identity.user, 'known-user');
});

test('quota refresh validates the strongest identity from every member sharing the refresh token', async context => {
  const { manager, bundle, preset } = await setup(context, { nativeFile: false });
  const weak = auth(bundle);
  weak.openai.id_token = jwt({ sub: 'same-sub', 'https://api.openai.com/auth': { chatgpt_account_id: 'shared-workspace' } });
  weak.openai.expires = Date.now() - 1;
  const strong = structuredClone(weak);
  strong.openai.opm_identity = { user: 'known-user' };
  await fs.writeFile(manager.getAuthPath(), bytes(weak));
  await fs.writeFile(preset('work'), bytes(weak));
  await fs.writeFile(preset('strong'), bytes(strong));
  const before = await snapshot(manager);
  const changed = response(native('one', 'changed'));
  changed.id_token = jwt({ sub: 'same-sub', 'https://api.openai.com/auth': { chatgpt_account_id: 'shared-workspace', chatgpt_user_id: 'wrong-user' } });
  manager._requestJson = async () => changed;
  assert.ok((await manager._refreshExpiredOpenAICredentials()).every(item => !item.success));
  await unchanged(before);
  assert.deepEqual(await fs.readFile(preset('strong')), bytes(strong));
});

test('genuine ID present only on the codex alias avoids unnecessary refresh', async context => {
  const { manager, bundle, codexPath } = await setup(context, { nativeFile: false });
  const source = auth(bundle);
  source.codex = { ...source.openai, id_token: bundle.tokens.id_token };
  await fs.writeFile(manager.getAuthPath(), bytes(source));
  await manager.savePreset('work');
  await manager.switchPreset('work');
  assert.equal(parseNative(await fs.readFile(codexPath)).tokens.id_token, bundle.tokens.id_token);
});

test('unknown independently saved access with a reused refresh requires explicit refresh, not an assumption of freshness', async context => {
  const { manager, bundle, codexPath } = await setup(context, { nativeFile: false });
  await manager.savePreset('work');
  const rotated = response(native('one', 'rotated-access'));
  delete rotated.refresh_token;
  const confirmed = native('one', 'confirmed-login');
  confirmed.tokens.refresh_token = bundle.tokens.refresh_token;
  let calls = 0;
  manager._requestJson = async () => { calls++; return calls === 1 ? rotated : response(confirmed); };
  await manager.switchPreset('work');
  const independent = native('one', 'independent-login');
  independent.tokens.refresh_token = bundle.tokens.refresh_token;
  await fs.writeFile(manager.getAuthPath(), bytes(auth(independent)));
  await fs.writeFile(codexPath, bytes(independent));
  await manager.savePreset('work');
  const before = await snapshot(manager);
  assert.equal(await manager.detectCurrentPreset(), null);
  await assert.rejects(manager.collectOpenAIKickoffTargets(), errorKey('sync_recovery_error'));
  await unchanged(before);
  assert.equal(calls, 1, 'recognition and kickoff cannot silently accept or refresh unknown lineage');
  await manager.switchPreset('work');
  assert.equal(calls, 2);
  assert.equal(JSON.parse(await fs.readFile(manager.getAuthPath())).openai.access, confirmed.tokens.access_token);
  assert.equal(parseNative(await fs.readFile(codexPath)).tokens.access_token, confirmed.tokens.access_token);
});

test('unknown older A0 sidecar is not resurrected across an A1/R to A2/R journal', async context => {
  const { manager, bundle, codexPath } = await setup(context);
  await manager.savePreset('work');
  const recorded = native('one', 'A2');
  recorded.tokens.refresh_token = bundle.tokens.refresh_token;
  await manager._writeJsonAtomic(manager._recoveryPath(bundle.tokens.refresh_token), {
    status: 'received', source_refresh: bundle.tokens.refresh_token, source_accesses: ['TEST-access-one-A1'],
    source_identity: { account: bundle.tokens.account_id, sub: 'one', user: 'one' },
    received_at: new Date().toISOString(), response: response(recorded),
  });
  const before = await snapshot(manager);
  await assert.rejects(manager._recoverOpenAI(auth(bundle).openai), errorKey('sync_recovery_error'));
  await unchanged(before);
  const confirmed = native('one', 'A3');
  let calls = 0;
  manager._requestJson = async (_url, options) => {
    calls++;
    assert.equal(new URLSearchParams(options.body).get('refresh_token'), bundle.tokens.refresh_token);
    await unchanged(before);
    return response(confirmed);
  };
  await manager.switchPreset('work');
  assert.equal(calls, 1);
  assert.equal(parseNative(await fs.readFile(codexPath)).tokens.access_token, confirmed.tokens.access_token);
  await manager.switchPreset('work');
  assert.equal(calls, 1);
});

test('kickoff groups converged R0/R1 recovery before parallel refresh and preserves all labels and strongest identity', async context => {
  const { manager, bundle, preset } = await setup(context);
  await manager.savePreset('work');
  const r1 = native('one', 'R1');
  const current = auth(r1);
  current.openai.expires = Date.now() - 1;
  await fs.writeFile(manager.getAuthPath(), bytes(current));
  await fs.writeFile(preset('copy'), bytes(current));
  await manager._writeJsonAtomic(manager._recoveryPath(bundle.tokens.refresh_token), {
    status: 'received', source_refresh: bundle.tokens.refresh_token, source_accesses: [bundle.tokens.access_token],
    source_identity: { account: bundle.tokens.account_id, sub: 'one', user: 'one' },
    received_at: new Date(Date.now() - 7200_000).toISOString(), response: response(r1),
  });
  const before = await snapshot(manager);
  const r2 = native('one', 'R2');
  const refreshes = [];
  const inferences = [];
  manager._requestJson = async (url, options) => {
    if (url.endsWith('/oauth/token')) {
      refreshes.push(new URLSearchParams(options.body).get('refresh_token'));
      await new Promise(resolve => setTimeout(resolve, 10));
      return response(r2);
    }
    assert.ok(url.endsWith('/codex/responses'));
    inferences.push(options.headers.Authorization);
    return { output_text: 'OK' };
  };
  const targets = await manager.collectOpenAIKickoffTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].refresh, r1.tokens.refresh_token);
  assert.equal(targets[0].opm_identity.user, 'one');
  assert.equal(refreshes.length, 0, 'collection is read-only');
  const result = await manager.runOpenAIKickoffBatch();
  assert.deepEqual(refreshes, [r1.tokens.refresh_token]);
  assert.deepEqual(inferences, [`Bearer ${r2.tokens.access_token}`]);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].error, null);
  assert.equal(result.results[0].presets.length, 3);
  assert.ok(result.results[0].presets.some(label => label.startsWith('work (')));
  assert.ok(result.results[0].presets.some(label => label.startsWith('copy (')));
  assert.ok(result.results[0].presets.some(label => label.startsWith('(Current Active:')));
  const log = JSON.parse(await fs.readFile(manager._recoveryPath(r1.tokens.refresh_token)));
  assert.equal(log.source_identity.user, 'one');
  assert.equal(log.response.refresh_token, r2.tokens.refresh_token);
  assert.doesNotMatch(JSON.stringify(result), /TEST-access|TEST-refresh|id_token/);
  await unchanged(before);
});

test('kickoff preserves inline ID, opm_identity and exact sidecar identity before refresh and rejects a different member', async context => {
  const { manager, preset } = await setup(context, { nativeFile: false });
  for (const source of ['id_token', 'idToken', 'opm_identity', 'sidecar']) {
    const original = native('one', source);
    const weak = auth(original);
    weak.openai.expires = Date.now() - 1;
    const strong = structuredClone(weak);
    if (source === 'sidecar') await manager._writeCodexSidecar('work', bytes(original));
    else {
      await manager._writeCodexSidecar('work', null);
      strong.openai[source] = source === 'opm_identity' ? { account: original.tokens.account_id, sub: 'one', user: 'one' } : original.tokens.id_token;
    }
    await fs.writeFile(manager.getAuthPath(), bytes(weak));
    await fs.writeFile(preset('work'), bytes(strong));
    const before = await snapshot(manager);
    let refreshes = 0;
    let inferences = 0;
    manager._requestJson = async url => {
      if (url.endsWith('/oauth/token')) { refreshes++; return response(native('wrong-member', source)); }
      inferences++;
      throw new Error('TEST-SECRET: inference must not be reached');
    };
    const result = await manager.runOpenAIKickoffBatch();
    assert.equal(result.results.length, 1, source);
    assert.equal(result.results[0].error, t('sync_recovery_error'), source);
    assert.equal(refreshes, 1, source);
    assert.equal(inferences, 0, source);
    const log = JSON.parse(await fs.readFile(manager._recoveryPath(original.tokens.refresh_token)));
    assert.equal(log.source_identity.user, 'one', source);
    await assert.rejects(manager._recoverOpenAI(weak.openai), errorKey('sync_recovery_error'));
    assert.doesNotMatch(JSON.stringify(result), /TEST-SECRET|TEST-access|TEST-refresh/);
    await unchanged(before);
  }
});

test('kickoff refuses conflicting exact sidecar identity and cached wrong-user recovery before any request', async context => {
  const { manager, bundle, preset } = await setup(context, { nativeFile: false });
  const strong = auth(bundle, true);
  strong.openai.expires = Date.now() - 1;
  await fs.writeFile(manager.getAuthPath(), bytes(strong));
  await fs.writeFile(preset('work'), bytes(strong));
  const wrong = native('wrong-member');
  wrong.tokens.access_token = bundle.tokens.access_token;
  wrong.tokens.refresh_token = bundle.tokens.refresh_token;
  await manager._writeCodexSidecar('work', bytes(wrong));
  await assert.rejects(manager.collectOpenAIKickoffTargets(), errorKey('sync_identity_error'));
  let batch = await manager.runOpenAIKickoffBatch();
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0].error, t('sync_recovery_error'));
  assert.equal(batch.results[0].inference_attempted, false);
  await manager._writeCodexSidecar('work', null);
  await manager._writeJsonAtomic(manager._recoveryPath(bundle.tokens.refresh_token), {
    status: 'received', source_refresh: bundle.tokens.refresh_token, source_accesses: [bundle.tokens.access_token],
    source_identity: { account: bundle.tokens.account_id }, received_at: new Date().toISOString(), response: response(native('wrong-member')),
  });
  await assert.rejects(manager.collectOpenAIKickoffTargets(), errorKey('sync_recovery_error'));
  batch = await manager.runOpenAIKickoffBatch();
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0].error, t('sync_recovery_error'));
  assert.equal(batch.results[0].inference_attempted, false);
  await assert.rejects(manager._ensureOpenAIAccessToken(manager._extractOpenAIOAuth(strong)), errorKey('sync_recovery_error'));
});

test('quota keeps known user context when ID is omitted, rejecting a later different member', async context => {
  const { manager, preset } = await setup(context);
  await manager.savePreset('work');
  const expired = JSON.parse(await fs.readFile(preset('work')));
  expired.openai.expires = Date.now() - 1;
  await fs.writeFile(preset('work'), bytes(expired));
  await fs.writeFile(manager.getAuthPath(), bytes(expired));
  const first = response(native('one', 'quota'));
  delete first.id_token;
  manager._requestJson = async () => first;
  assert.ok((await manager._refreshExpiredOpenAICredentials()).every(item => item.success));
  assert.equal(JSON.parse(await fs.readFile(preset('work'))).openai.opm_identity.sub, 'one');
  const before = await snapshot(manager);
  manager._requestJson = async () => response(native('wrong-member', 'next'));
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_recovery_error'));
  await unchanged(before);
});

test('missing-ID recovery retries with returned refresh credentials, never the spent originals', async context => {
  const { manager } = await setup(context, { nativeFile: false });
  await manager.savePreset('work');
  const first = response(native('one', 'first'));
  delete first.id_token;
  const requests = [];
  manager._requestJson = async (_url, options) => {
    requests.push(new URLSearchParams(options.body).get('refresh_token'));
    return requests.length === 1 ? first : response(native('one', 'second'));
  };
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_recovery_error'));
  await manager.switchPreset('work');
  assert.deepEqual(requests, ['TEST-refresh-one-initial', 'TEST-refresh-one-first']);
  assert.equal(JSON.parse(await fs.readFile(manager.getAuthPath())).openai.refresh, 'TEST-refresh-one-second');
});

test('each unified transaction target rolls back on one-shot write failure, including metadata after-write failure', async context => {
  const { manager, codexPath, proxyPath, preset } = await setup(context);
  await fs.writeFile(manager.openCodeGoConfigFile, JSON.stringify({ workspaceId: 'TEST-work', authCookie: 'TEST-cookie' }));
  await manager.savePreset('work');
  const other = native('other');
  await fs.writeFile(manager.getAuthPath(), bytes(auth(other)));
  await fs.writeFile(codexPath, bytes(other));
  await fs.mkdir(dirname(proxyPath), { recursive: true });
  await fs.writeFile(proxyPath, bytes(proxyAuthFromEntry(auth(other).openai)));
  await fs.writeFile(manager.openCodeGoConfigFile, JSON.stringify({ workspaceId: 'TEST-other', authCookie: 'TEST-other-cookie' }));
  const before = await snapshot(manager);
  const memory = structuredClone(manager.config);
  const write = manager._writeBytesAtomic.bind(manager);
  for (const target of [manager.getAuthPath(), codexPath, proxyPath, preset('work'), manager._codexSidecarPath('work'), manager.openCodeGoConfigFile, manager.configFile]) {
    let failed = false;
    manager._writeBytesAtomic = async (path, data) => {
      if (path === target && !failed) { failed = true; throw new Error('TEST-injected-write-failure'); }
      return write(path, data);
    };
    await assert.rejects(manager.switchPreset('work'), /TEST-injected/);
    await unchanged(before);
    assert.deepEqual(manager.config, memory);
  }
  manager._writeBytesAtomic = write;
  const save = manager._saveConfig.bind(manager);
  manager._saveConfig = async () => { await save(); throw new Error('TEST-post-config-failure'); };
  await assert.rejects(manager.switchPreset('work'), /TEST-post-config/);
  await unchanged(before);
});

test('all rollback targets are attempted even when an early restore fails', async context => {
  const { manager, codexPath, proxyPath } = await setup(context);
  await manager.savePreset('work');
  const other = native('other');
  await fs.writeFile(manager.getAuthPath(), bytes(auth(other)));
  await fs.writeFile(codexPath, bytes(other));
  await fs.mkdir(dirname(proxyPath), { recursive: true });
  await fs.writeFile(proxyPath, bytes(proxyAuthFromEntry(auth(other).openai)));
  const before = await snapshot(manager);
  const write = manager._writeBytesAtomic.bind(manager);
  let restoring = false;
  const attempts = [];
  manager._saveConfig = async () => { restoring = true; throw new Error('TEST-config'); };
  manager._writeBytesAtomic = async (path, data) => {
    if (restoring) {
      attempts.push(path);
      if (path === manager.getAuthPath()) throw new Error('TEST-restore');
    }
    return write(path, data);
  };
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_rollback_error'));
  assert.ok(attempts.includes(codexPath));
  assert.ok(attempts.includes(proxyPath));
  assert.ok(attempts.includes(manager.configFile));
  assert.ok(attempts.includes(manager._codexSidecarPath('work')));
  before.delete(manager.getAuthPath());
  await unchanged(before);
});

test('dual-write failure after rotation retains recovery and next switch uses rotated credentials without another request', async context => {
  const { manager, codexPath } = await setup(context, { nativeFile: false });
  await manager.savePreset('work');
  const before = await snapshot(manager);
  let calls = 0;
  manager._requestJson = async () => { calls++; return response(native('one', 'rotated')); };
  const write = manager._writeBytesAtomic.bind(manager);
  let failed = false;
  manager._writeBytesAtomic = async (path, data) => {
    if (path === codexPath && !failed) { failed = true; throw new Error('TEST-codex-write'); }
    return write(path, data);
  };
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_rotated_error'));
  await unchanged(before);
  await manager.switchPreset('work');
  assert.equal(calls, 1);
  assert.equal(parseNative(await fs.readFile(codexPath)).tokens.refresh_token, 'TEST-refresh-one-rotated');
});

test('backup failure aborts before refresh, and rotated-response backup failure keeps targets untouched', async context => {
  const { manager, bundle } = await setup(context, { nativeFile: false });
  await manager.savePreset('work');
  const before = await snapshot(manager);
  const backup = manager._writePrivateBackup.bind(manager);
  manager._writePrivateBackup = async () => { throw new Error('TEST-backup'); };
  await assert.rejects(manager.switchPreset('work'), /TEST-backup/);
  await unchanged(before);
  manager._writePrivateBackup = backup;
  manager._requestJson = async () => response(native('one', 'rotated'));
  const write = manager._writeJsonAtomic.bind(manager);
  manager._writeJsonAtomic = async (path, value) => {
    if (path === manager._recoveryPath(bundle.tokens.refresh_token) && value.status === 'received') throw new Error('TEST-recovery-write');
    return write(path, value);
  };
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_recovery_write_error'));
  await unchanged(before);
  const copies = (await fs.readdir(manager.backupsDir)).filter(file => file.startsWith('rotated_openai_recovery'));
  assert.equal(copies.length, 1);
  assert.equal(JSON.parse(await fs.readFile(join(manager.backupsDir, copies[0]))).response.refresh_token, 'TEST-refresh-one-rotated');
});

test('shared refresh recovery prevents an untouched duplicate preset from resurrecting spent tokens', async context => {
  const { manager, preset } = await setup(context, { nativeFile: false });
  await manager.savePreset('work');
  await fs.copyFile(preset('work'), preset('copy'));
  let calls = 0;
  manager._requestJson = async () => { calls++; return response(native('one', 'rotated')); };
  await manager.switchPreset('work');
  await manager.switchPreset('copy');
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await fs.readFile(preset('copy'))).openai.refresh, 'TEST-refresh-one-rotated');
});

test('quota refresh updates or invalidates linked ID data; next switch cannot restore stale tokens', async context => {
  const { manager, preset, codexPath } = await setup(context);
  for (const includeId of [true, false]) {
    const initial = native('one', String(includeId));
    await fs.writeFile(manager.getAuthPath(), bytes(auth(initial)));
    await fs.writeFile(codexPath, bytes(initial));
    await manager.savePreset('work');
    const expired = JSON.parse(await fs.readFile(preset('work')));
    expired.openai.expires = Date.now() - 1;
    await fs.writeFile(preset('work'), bytes(expired));
    await fs.writeFile(manager.getAuthPath(), bytes(expired));
    let calls = 0;
    const requests = [];
    manager._requestJson = async (_url, options) => {
      calls++;
      requests.push(new URLSearchParams(options.body).get('refresh_token'));
      const result = response(native('one', `${includeId}-${calls}`));
      if (!includeId && calls === 1) delete result.id_token;
      return result;
    };
    const results = await manager._refreshExpiredOpenAICredentials();
    assert.ok(results.every(result => result.success));
    assert.deepEqual(await fs.readFile(codexPath), bytes(initial), 'quota does not rewrite native auth');
    if (!includeId) await assert.rejects(fs.stat(manager._codexSidecarPath('work')), { code: 'ENOENT' });
    else assert.equal(parseNative(await fs.readFile(manager._codexSidecarPath('work'))).tokens.access_token, 'TEST-access-one-true-1');
    assert.equal(await manager.detectCurrentPreset(), null);
    await manager.switchPreset('work');
    assert.equal(calls, includeId ? 1 : 2);
    if (!includeId) assert.equal(requests[1], 'TEST-refresh-one-false-1');
    assert.equal(parseNative(await fs.readFile(codexPath)).tokens.refresh_token, `TEST-refresh-one-${includeId}-${calls}`);
  }
});

test('read-only detection checks all three linked destinations even with Go environment overrides', async context => {
  const { manager, codexPath, proxyPath } = await setup(context);
  await manager.savePreset('work');
  await manager.switchPreset('work');
  const before = await snapshot(manager);
  const old = process.env.OPENCODE_GO_WORKSPACE_ID;
  process.env.OPENCODE_GO_WORKSPACE_ID = 'TEST-override';
  try {
    assert.equal(await manager.detectCurrentPreset(), 'work');
    await unchanged(before);
    const originalProxy = JSON.parse(await fs.readFile(proxyPath));
    for (const field of ['access', 'refresh', 'accountId', 'expires']) {
      await fs.writeFile(proxyPath, bytes({ ...originalProxy, [field]: field === 'expires' ? originalProxy.expires + 1 : 'TEST-mismatch' }));
      assert.equal(await manager.detectCurrentPreset(), null, field);
    }
    const { accountId, ...legacyProxy } = originalProxy;
    await fs.writeFile(proxyPath, bytes({ ...legacyProxy, account_id: accountId }));
    assert.equal(await manager.detectCurrentPreset(), 'work', 'legacy account_id is read but never written');
    await fs.writeFile(proxyPath, bytes({ ...originalProxy, account_id: 'TEST-conflict' }));
    assert.equal(await manager.detectCurrentPreset(), null);
    await fs.unlink(proxyPath);
    assert.equal(await manager.detectCurrentPreset(), null);
    await fs.writeFile(proxyPath, before.get(proxyPath));
    await fs.writeFile(codexPath, bytes(native('different-member')));
    assert.equal(await manager.detectCurrentPreset(), null);
    await fs.writeFile(codexPath, before.get(codexPath));
    await fs.writeFile(join(dirname(codexPath), 'config.toml'), 'cli_auth_credentials_store = "keyring"');
    assert.equal(await manager.detectCurrentPreset(), null);
  } finally {
    if (old === undefined) delete process.env.OPENCODE_GO_WORKSPACE_ID; else process.env.OPENCODE_GO_WORKSPACE_ID = old;
  }
});

test('distribution invalidates mismatched linkage and deletion cleans only that preset link', async context => {
  const { manager, preset } = await setup(context);
  await manager.savePreset('work');
  await manager.savePreset('keep');
  const next = auth(native('other'));
  await fs.writeFile(preset('source'), bytes(next));
  manager.config.current_preset = 'source';
  await manager._saveConfig();
  await manager.distributeCurrentPresetCredentials({ authServiceKeys: ['openai'], targetNames: ['work'] });
  await assert.rejects(fs.stat(manager._codexSidecarPath('work')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(preset('work'))).openai.refresh, next.openai.refresh);
  await manager.deletePreset('keep');
  await assert.rejects(fs.stat(manager._codexSidecarPath('keep')), { code: 'ENOENT' });
  assert.ok(await fs.stat(preset('source')));
});

test('real TOML parser accepts unrelated multiline/inline config and rejects effective non-file stores', async context => {
  const { manager, codexPath } = await setup(context);
  await manager.savePreset('work');
  const config = join(dirname(codexPath), 'config.toml');
  const accepted = `"cli_auth_credentials_\\u0073tore" = "file"
model = "example"
notes = """unrelated encrypted keyring secrets text
multiline"""
features = { example = true, encrypted_secrets = false }
[mcp_servers.example]
args = [
  "--flag", "C:\\\\example", # ordinary TOML
]
env = { secret = "TEST-unrelated" }
[profiles.work]
model_reasoning_effort = "high"
`;
  await fs.writeFile(config, accepted);
  await manager.switchPreset('work');
  assert.equal(await fs.readFile(config, 'utf8'), accepted);
  for (const rejected of ['cli_auth_credentials_store = "auto"', 'cli_auth_credentials_store = "keyring"',
    '"cli_auth_credentials_\\u0073tore" = "auto"', '[profiles.work]\ncli_auth_credentials_store = "auto"',
    '[features]\nexperimental_encrypted_secrets = true', 'model = "unterminated',
    'cli_auth_credentials_store = "file"\ncli_auth_credentials_store = "auto"']) {
    await fs.writeFile(config, rejected);
    const before = await snapshot(manager);
    await assert.rejects(manager.switchPreset('work'), errorKey('sync_store_error'));
    await unchanged(before);
  }
});

test('no OpenAI OAuth preserves Codex and proxy without applying their path or store gates', async context => {
  const { manager, codexPath, proxyPath } = await setup(context);
  await fs.writeFile(join(dirname(codexPath), 'config.toml'), 'cli_auth_credentials_store = "keyring"');
  const existing = await fs.readFile(codexPath);
  await fs.mkdir(dirname(proxyPath), { recursive: true });
  await fs.writeFile(proxyPath, 'TEST-existing-proxy-bytes');
  await fs.writeFile(manager.getAuthPath(), bytes({ openai: { type: 'api', key: 'TEST-api' }, anthropic: { type: 'oauth', refresh: 'TEST-other' } }));
  await manager.savePreset('work');
  const result = await manager.switchPreset('work');
  assert.equal(result.codex_synced, false);
  assert.equal(result.proxy_synced, false);
  assert.equal(result.proxy_path, null);
  assert.deepEqual(await fs.readFile(codexPath), existing);
  assert.equal(await fs.readFile(proxyPath, 'utf8'), 'TEST-existing-proxy-bytes');
  process.env.CCP_CONFIG_DIR = manager.configDir;
  assert.equal((await manager.switchPreset('work')).proxy_synced, false);
  assert.equal(await manager.detectCurrentPreset(), 'work');
});

test('CODEX_HOME trim/default/no-fallback and overlap checks isolate destination paths', async context => {
  const { manager, dir, bundle, codexPath } = await setup(context, { inline: true });
  await manager.savePreset('work');
  const isolated = join(dir, 'other-codex-home');
  process.env.CODEX_HOME = `  ${isolated}  `;
  await manager.switchPreset('work');
  assert.deepEqual(parseNative(await fs.readFile(join(isolated, 'auth.json'))).tokens, bundle.tokens);
  assert.deepEqual(await fs.readFile(codexPath), bytes(bundle));
  process.env.CODEX_HOME = '   ';
  assert.equal(getCodexAuthPath(), codexPath);
  for (const path of [manager.configDir, manager.presetsDir, dirname(manager.getAuthPath()), dir]) {
    process.env.CODEX_HOME = path;
    await assert.rejects(manager.switchPreset('work'), errorKey('sync_path_error'));
  }
});

test('symlink source/destinations/ancestors and unsafe names fail before mutation', async context => {
  const { manager, dir, preset, codexPath, proxyPath } = await setup(context);
  await manager.savePreset('work');
  await fs.mkdir(dirname(proxyPath), { recursive: true });
  await fs.writeFile(proxyPath, 'TEST-proxy');
  for (const path of [manager.getAuthPath(), codexPath, preset('work'), manager.configFile, manager._codexSidecarPath('work'),
    dirname(codexPath), manager.codexSidecarsDir, manager.backupsDir, proxyPath, dirname(proxyPath), dirname(dirname(proxyPath))]) {
    const moved = join(dir, 'moved');
    await fs.rename(path, moved);
    await fs.symlink(moved, path);
    await assert.rejects(manager.switchPreset('work'), errorKey('sync_path_error'));
    await fs.unlink(path);
    await fs.rename(moved, path);
  }
  for (const name of ['..', '../escape', 'x/y', 'x\\y', '\x1bname', '\u202ename', '__proto__', 'constructor', ' ']) {
    await assert.rejects(manager.switchPreset(name), /unsafe characters/);
    await assert.rejects(manager.savePreset(name), /unsafe characters/);
  }
});

test('malformed input/UTF8/config never clears selected state or auth', async context => {
  const { manager, preset } = await setup(context);
  await manager.savePreset('work');
  const originalPreset = await fs.readFile(preset('work'));
  const originalConfig = await fs.readFile(manager.configFile);
  for (const invalid of [Buffer.from('{TEST-secret'), bytes([]), Buffer.from([0xff])]) {
    await fs.writeFile(preset('work'), invalid);
    const before = await snapshot(manager);
    await assert.rejects(manager.switchPreset('work'), errorKey('sync_auth_error'));
    await unchanged(before);
  }
  await fs.writeFile(preset('work'), originalPreset);
  await fs.writeFile(manager.configFile, '{TEST-private-invalid-state');
  const before = await snapshot(manager);
  await assert.rejects(manager.switchPreset('work'), errorKey('sync_auth_error'));
  await unchanged(before);
  await fs.writeFile(manager.configFile, originalConfig);
});

test('normal CLI save/switch dual-writes without a separate Codex command; failures redact raw errors', async context => {
  const { dir, bundle, codexPath } = await setup(context);
  const coreUrl = new URL('../src/core.js', import.meta.url).href;
  const cliUrl = new URL('../src/cli.js', import.meta.url);
  const preload = `import{PresetManager}from${JSON.stringify(coreUrl)};const init=PresetManager.prototype.init;PresetManager.prototype.init=async function(){await init.call(this);this._requestJson=async()=>{throw new Error('TEST-SECRET-NETWORK')};};`;
  const env = { HOME: dir, PATH: process.env.PATH, OPM_LANG: 'en', CODEX_HOME: dirname(codexPath), OPM_AUTH_PATH: process.env.OPM_AUTH_PATH };
  const run = (...args) => execFileSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), cliUrl.pathname, ...args],
    { env, encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
  assert.match(run('save', 'work'), /Saved preset/);
  await fs.writeFile(codexPath, bytes(native('other')));
  assert.match(run('switch', 'work'), /OpenCode \+ Codex/);
  assert.deepEqual(parseNative(await fs.readFile(codexPath)).tokens, bundle.tokens);
  assert.throws(() => run('codex', 'switch', 'work'), error => error.status === 1);
  assert.throws(() => run('switch', '../TEST-SECRET-path'), error => {
    assert.equal(error.status, 1);
    assert.doesNotMatch(error.stdout + error.stderr, /TEST-SECRET|SUCCESS|installed successfully/);
    return true;
  });
  const stored = join(dir, '.config', 'oauth-preset-manager', 'presets', 'work.json');
  await fs.writeFile(stored, bytes(auth(native('fresh-user'))));
  assert.throws(() => run('switch', 'work'), error => {
    assert.equal(error.status, 1);
    assert.doesNotMatch(error.stdout + error.stderr, /TEST-SECRET|SUCCESS/);
    assert.match(error.stderr, /remote rollback/);
    return true;
  });
});

test('normal interactive preset selection reaches the unified switch', async context => {
  const { manager, codexPath } = await setup(context);
  await manager.savePreset('work');
  await fs.writeFile(codexPath, bytes(native('other')));
  await interactiveMode(manager, { select: async () => 'work', confirm: async () => false, input: async () => '' });
  assert.equal(await manager.detectCurrentPreset(), 'work');
  assert.equal(buildInteractiveChoices([]).some(choice => choice?.value === '__codex__'), false);
});

test('Escape and Ctrl-C cannot terminate the unified switch at the auth/metadata boundary', async context => {
  const { manager } = await setup(context);
  await manager.savePreset('work');
  const originalStdin = process.stdin;
  const originalExit = process.exit;
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isPaused = () => true;
  stdin.setRawMode = value => { stdin.isRaw = value; };
  stdin.pause = () => {};
  let exits = 0;
  let exitStatus;
  let cleanup;
  const originalSignals = process.listenerCount('SIGINT');
  Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
  process.exit = code => { exits++; exitStatus = code; };
  try {
    cleanup = enableEscToExit();
    const save = manager._saveConfig.bind(manager);
    manager._saveConfig = async () => {
      stdin.emit('keypress', '', { name: 'escape' });
      stdin.emit('keypress', '\x03', { name: 'c', ctrl: true });
      assert.equal(process.listenerCount('SIGINT'), originalSignals + 1);
      process.emit('SIGINT');
      assert.equal(exits, 0);
      await save();
    };
    await cmdSwitch(manager, 'work');
    assert.equal(exits, 0);
    assert.equal(process.listenerCount('SIGINT'), originalSignals);
    stdin.emit('keypress', '', { name: 'escape' });
    assert.equal(exits, 1);
    manager.switchPreset = async () => { throw new Error('TEST-failed-switch'); };
    await cmdSwitch(manager, 'work');
    stdin.emit('keypress', '', { name: 'escape' });
    assert.equal(exitStatus, 1, 'Escape must preserve a failed switch exit status');
  } finally {
    cleanup?.();
    process.exit = originalExit;
    Object.defineProperty(process, 'stdin', { configurable: true, value: originalStdin });
  }
});

test('unified success/skip/recovery warnings are available in both languages', () => {
  for (const language of ['ko', 'en']) {
    setLanguage(language);
    for (const key of ['sync_restart', 'sync_both_success', 'sync_codex_skipped', 'sync_rotated_error', 'sync_store_error']) assert.notEqual(t(key), key);
  }
  setLanguage('en');
});
