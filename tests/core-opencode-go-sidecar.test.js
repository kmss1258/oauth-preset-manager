import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PresetManager } from '../src/core.js';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'opm-sidecar-'));
  const manager = new PresetManager(dir);
  await manager.init();
  return { dir, manager };
}

const session = { workspaceId: 'wrk_test', authCookie: 'cookie_test' };

test('stored Go session snapshots to sidecar and restores on switch', async () => {
  const { dir, manager } = await setup();
  try {
    const auth = join(dir, 'active.json');
    await writeFile(auth, JSON.stringify({ 'opencode-go': { type: 'api', key: 'api' } }));
    await manager.setAuthPath(auth);
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify({ ...session, ignored: 'field' }));
    await manager.savePreset('one');
    assert.deepEqual(JSON.parse(await readFile(join(manager.sidecarsDir, 'one.json'))), session);
    assert.equal((await stat(manager.sidecarsDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(manager.sidecarsDir, 'one.json'))).mode & 0o777, 0o600);
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify({ workspaceId: 'other', authCookie: 'other' }));
    await manager.switchPreset('one', false);
    assert.deepEqual(JSON.parse(await readFile(manager.openCodeGoConfigFile)), session);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy preset without sidecar preserves global Go session and detection is session-aware', async () => {
  const { dir, manager } = await setup();
  try {
    const auth = join(dir, 'active.json');
    const bytes = JSON.stringify({ openai: { type: 'oauth', refresh: 'r' } });
    await writeFile(auth, bytes);
    await manager.setAuthPath(auth);
    await manager.savePreset('legacy');
    await rm(join(manager.sidecarsDir, 'legacy.json'), { force: true });
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify(session));
    assert.equal(await manager.detectCurrentPreset(), 'legacy');
    await manager.switchPreset('legacy', false);
    assert.deepEqual(JSON.parse(await readFile(manager.openCodeGoConfigFile)), session);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('session distribution changes only selected targets and preserves API-only auth', async () => {
  const { dir, manager } = await setup();
  try {
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify(session));
    for (const [name, data] of Object.entries({ source: { openai: { type: 'oauth', refresh: 'new' }, 'opencode-go': { type: 'api', key: 'new-api' } }, target: { openai: { type: 'oauth', refresh: 'old' }, google: { type: 'oauth', refresh: 'keep' }, 'opencode-go': { type: 'api', key: 'old-api' } }, untouched: { openai: { type: 'oauth', refresh: 'untouched' } } })) await writeFile(join(manager.presetsDir, `${name}.json`), JSON.stringify(data));
    manager.config.current_preset = 'source';
    await manager._saveConfig();
    const result = await manager.distributeCurrentPresetCredentials({ authServiceKeys: ['opencode-go'], includeOpenCodeGoSession: true, targetNames: ['target', 'target', 'source', 'untouched'] });
    assert.deepEqual(result.changed.map(item => item.preset_name), ['target', 'untouched']);
    assert.equal(result.source_sidecar_changed, true);
    assert.equal(result.source_sidecar_backup_path, null);
    assert.deepEqual(JSON.parse(await readFile(join(manager.sidecarsDir, 'source.json'))), session);
    assert.equal(JSON.parse(await readFile(join(manager.presetsDir, 'target.json'))).google.refresh, 'keep');
    assert.deepEqual(JSON.parse(await readFile(join(manager.sidecarsDir, 'target.json'))), session);
    assert.equal((await readdir(manager.sidecarsDir)).includes('untouched.json'), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('distribution backs up a differing source and target sidecar and reports metadata only', async () => {
  const { dir, manager } = await setup();
  try {
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify(session));
    await writeFile(join(manager.presetsDir, 'source.json'), JSON.stringify({ openai: { type: 'oauth' } }));
    await writeFile(join(manager.presetsDir, 'target.json'), JSON.stringify({ openai: { type: 'oauth' } }));
    await writeFile(join(manager.sidecarsDir, 'source.json'), JSON.stringify({ workspaceId: 'old', authCookie: 'old' }));
    await writeFile(join(manager.sidecarsDir, 'target.json'), JSON.stringify({ workspaceId: 'old', authCookie: 'old' }));
    manager.config.current_preset = 'source';
    await manager._saveConfig();
    const result = await manager.distributeCurrentPresetCredentials({ includeOpenCodeGoSession: true, targetNames: ['target'] });
    assert.match(result.source_sidecar_backup_path, /before_credential_distribution_source_opencode-go_/);
    assert.match(result.changed[0].sidecar_backup_path, /before_credential_distribution_target_opencode-go_/);
    assert.equal(await readFile(result.source_sidecar_backup_path, 'utf8'), JSON.stringify({ workspaceId: 'old', authCookie: 'old' }));
    assert.equal(await readFile(result.changed[0].sidecar_backup_path, 'utf8'), JSON.stringify({ workspaceId: 'old', authCookie: 'old' }));
    assert.equal(JSON.stringify(result).includes('cookie_test'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('batch distribution restores source and all targets when a later target write fails', async () => {
  const { dir, manager } = await setup();
  try {
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify(session));
    const original = {
      source: { openai: { type: 'oauth', refresh: 'source' } },
      one: { openai: { type: 'oauth', refresh: 'one' } },
      two: { openai: { type: 'oauth', refresh: 'two' } },
    };
    for (const [name, data] of Object.entries(original)) await writeFile(join(manager.presetsDir, `${name}.json`), JSON.stringify(data));
    await writeFile(join(manager.sidecarsDir, 'one.json'), JSON.stringify({ workspaceId: 'one', authCookie: 'one' }));
    await writeFile(join(manager.sidecarsDir, 'two.json'), JSON.stringify({ workspaceId: 'two', authCookie: 'two' }));
    manager.config.current_preset = 'source';
    await manager._saveConfig();
    const before = new Map([
      ['source', await readFile(join(manager.presetsDir, 'source.json'))],
      ['one', await readFile(join(manager.presetsDir, 'one.json'))],
      ['two', await readFile(join(manager.presetsDir, 'two.json'))],
      ['one-sidecar', await readFile(join(manager.sidecarsDir, 'one.json'))],
      ['two-sidecar', await readFile(join(manager.sidecarsDir, 'two.json'))],
    ]);
    const originalWrite = manager._writeJsonAtomic.bind(manager);
    manager._writeJsonAtomic = async (path, data) => {
      if (path === join(manager.presetsDir, 'two.json')) throw new Error('target two failure');
      return originalWrite(path, data);
    };
    await assert.rejects(manager.distributeCurrentPresetCredentials({ authServiceKeys: ['openai'], includeOpenCodeGoSession: true, targetNames: ['one', 'two'] }), /target two failure/);
    assert.deepEqual(await readFile(join(manager.presetsDir, 'source.json')), before.get('source'));
    assert.deepEqual(await readFile(join(manager.presetsDir, 'one.json')), before.get('one'));
    assert.deepEqual(await readFile(join(manager.presetsDir, 'two.json')), before.get('two'));
    assert.deepEqual(await readFile(join(manager.sidecarsDir, 'one.json')), before.get('one-sidecar'));
    assert.deepEqual(await readFile(join(manager.sidecarsDir, 'two.json')), before.get('two-sidecar'));
    assert.equal(await readFile(join(manager.sidecarsDir, 'source.json')).catch(() => null), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('session distribution validates the boolean before reading or writing', async () => {
  const { dir, manager } = await setup();
  try {
    await assert.rejects(manager.distributeCurrentPresetCredentials({ includeOpenCodeGoSession: 'yes' }), /must be a boolean/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('save and overwrite roll back preset, sidecar, config, and memory on sidecar failure', async () => {
  const { dir, manager } = await setup();
  try {
    const auth = join(dir, 'active.json');
    await writeFile(auth, JSON.stringify({ openai: { type: 'oauth', refresh: 'new' } }));
    await manager.setAuthPath(auth);
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify(session));
    await manager.savePreset('one');
    const beforePreset = await readFile(join(manager.presetsDir, 'one.json'));
    const beforeSidecar = await readFile(join(manager.sidecarsDir, 'one.json'));
    const beforeConfig = await readFile(manager.configFile);
    const oldConfig = structuredClone(manager.config);
    await writeFile(auth, JSON.stringify({ openai: { type: 'oauth', refresh: 'changed' } }));
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify({ workspaceId: 'other', authCookie: 'other' }));
    manager._writeJsonAtomic = async () => { throw new Error('sidecar failure'); };
    await assert.rejects(manager.overwritePresetFromCurrent('one', false), /sidecar failure/);
    assert.deepEqual(await readFile(join(manager.presetsDir, 'one.json')), beforePreset);
    assert.deepEqual(await readFile(join(manager.sidecarsDir, 'one.json')), beforeSidecar);
    assert.deepEqual(await readFile(manager.configFile), beforeConfig);
    assert.deepEqual(manager.config, oldConfig);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('sidecars are outside the preset list scan and delete removes only the matching sidecar', async () => {
  const { dir, manager } = await setup();
  try {
    await writeFile(join(manager.presetsDir, 'one.json'), '{}');
    await writeFile(join(manager.sidecarsDir, 'one.json'), JSON.stringify(session));
    manager.config.presets.one = {};
    assert.deepEqual((await manager.listPresets()).map(item => item.name), ['one']);
    await manager.deletePreset('one');
    assert.equal(await readFile(join(manager.sidecarsDir, 'one.json')).catch(() => null), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid sidecar is rejected before active auth or config mutation', async () => {
  const { dir, manager } = await setup();
  try {
    const auth = join(dir, 'active.json');
    await writeFile(auth, 'active-bytes');
    await manager.setAuthPath(auth);
    await writeFile(join(manager.presetsDir, 'one.json'), '{}');
    await writeFile(join(manager.sidecarsDir, 'one.json'), JSON.stringify({ workspaceId: 'x', authCookie: 'y', extra: true }));
    manager.config.current_preset = 'before';
    await manager._saveConfig();
    const authBefore = await readFile(auth);
    const configBefore = await readFile(manager.configFile);
    await assert.rejects(manager.switchPreset('one', false), /Invalid OpenCode Go sidecar/);
    assert.deepEqual(await readFile(auth), authBefore);
    assert.deepEqual(await readFile(manager.configFile), configBefore);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('switch rolls active auth, global session, config, and memory back on global write failure', async () => {
  const { dir, manager } = await setup();
  try {
    const auth = join(dir, 'active.json');
    await writeFile(auth, 'active-bytes');
    await manager.setAuthPath(auth);
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify({ workspaceId: 'old', authCookie: 'old' }));
    await writeFile(join(manager.presetsDir, 'one.json'), JSON.stringify({ openai: { type: 'oauth', refresh: 'new' } }));
    await writeFile(join(manager.sidecarsDir, 'one.json'), JSON.stringify(session));
    manager.config.current_preset = 'before';
    await manager._saveConfig();
    const authBefore = await readFile(auth);
    const globalBefore = await readFile(manager.openCodeGoConfigFile);
    const configBefore = await readFile(manager.configFile);
    const memoryBefore = structuredClone(manager.config);
    const originalWrite = manager._writeJsonAtomic.bind(manager);
    manager._writeJsonAtomic = async (path, data) => {
      if (path === manager.openCodeGoConfigFile) throw new Error('global failure');
      return originalWrite(path, data);
    };
    await assert.rejects(manager.switchPreset('one', false), /global failure/);
    assert.deepEqual(await readFile(auth), authBefore);
    assert.deepEqual(await readFile(manager.openCodeGoConfigFile), globalBefore);
    assert.deepEqual(await readFile(manager.configFile), configBefore);
    assert.deepEqual(manager.config, memoryBefore);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('overwrite rolls back exact files when config save fails', async () => {
  const { dir, manager } = await setup();
  try {
    const auth = join(dir, 'active.json');
    await writeFile(auth, JSON.stringify({ openai: { type: 'oauth', refresh: 'new' } }));
    await manager.setAuthPath(auth);
    await writeFile(join(manager.presetsDir, 'one.json'), JSON.stringify({ openai: { type: 'oauth', refresh: 'old' } }));
    await writeFile(join(manager.sidecarsDir, 'one.json'), JSON.stringify(session));
    const beforePreset = await readFile(join(manager.presetsDir, 'one.json'));
    const beforeSidecar = await readFile(join(manager.sidecarsDir, 'one.json'));
    const beforeConfig = await readFile(manager.configFile);
    manager._saveConfig = async () => { throw new Error('config failure'); };
    await assert.rejects(manager.overwritePresetFromCurrent('one', false), /config failure/);
    assert.deepEqual(await readFile(join(manager.presetsDir, 'one.json')), beforePreset);
    assert.deepEqual(await readFile(join(manager.sidecarsDir, 'one.json')), beforeSidecar);
    assert.deepEqual(await readFile(manager.configFile), beforeConfig);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('save and overwrite preserve an existing sidecar when stored global Go data is invalid', async () => {
  const { dir, manager } = await setup();
  try {
    const auth = join(dir, 'active.json');
    await writeFile(auth, JSON.stringify({ openai: { type: 'oauth', refresh: 'current' } }));
    await manager.setAuthPath(auth);
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify({ workspaceId: 'valid', authCookie: 'valid' }));
    await manager.savePreset('one');
    const sidecarPath = join(manager.sidecarsDir, 'one.json');
    const before = await readFile(sidecarPath);
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify({ workspaceId: '' }));
    await manager.savePreset('one');
    assert.deepEqual(await readFile(sidecarPath), before);
    await writeFile(manager.openCodeGoConfigFile, 'malformed');
    await manager.overwritePresetFromCurrent('one', false);
    assert.deepEqual(await readFile(sidecarPath), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('new sidecar paths reject symlinks and init enforces regular global mode', async () => {
  const { dir, manager } = await setup();
  try {
    const real = join(dir, 'real-sidecar.json');
    const sidecar = join(manager.sidecarsDir, 'one.json');
    await writeFile(real, JSON.stringify(session));
    await symlink(real, sidecar);
    await assert.rejects(manager._readSidecar('one'), /Unsafe OpenCode Go sidecar path/);
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify(session));
    await chmod(manager.openCodeGoConfigFile, 0o644);
    await manager.init();
    assert.equal((await stat(manager.openCodeGoConfigFile)).mode & 0o777, 0o600);
    await rm(manager.openCodeGoConfigFile);
    await symlink(real, manager.openCodeGoConfigFile);
    assert.equal(await manager._readStoredOpenCodeGoSession(), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('environment Go overrides are ignored for snapshot persistence', async () => {
  const { dir, manager } = await setup();
  const oldWorkspace = process.env.OPENCODE_GO_WORKSPACE_ID;
  const oldCookie = process.env.OPENCODE_GO_AUTH_COOKIE;
  try {
    process.env.OPENCODE_GO_WORKSPACE_ID = 'env_workspace';
    process.env.OPENCODE_GO_AUTH_COOKIE = 'env_cookie';
    const auth = join(dir, 'active.json');
    await writeFile(auth, JSON.stringify({ openai: { type: 'oauth' } }));
    await manager.setAuthPath(auth);
    await manager.savePreset('env');
    assert.equal(await readFile(join(manager.sidecarsDir, 'env.json')).catch(() => null), null);
  } finally {
    if (oldWorkspace === undefined) delete process.env.OPENCODE_GO_WORKSPACE_ID; else process.env.OPENCODE_GO_WORKSPACE_ID = oldWorkspace;
    if (oldCookie === undefined) delete process.env.OPENCODE_GO_AUTH_COOKIE; else process.env.OPENCODE_GO_AUTH_COOKIE = oldCookie;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Unicode preset names with spaces preserve the original name and use a Go sidecar', async () => {
  const { dir, manager } = await setup();
  try {
    const name = '개인 작업';
    const auth = join(dir, 'active.json');
    await writeFile(auth, JSON.stringify({ openai: { type: 'oauth', refresh: 'r' } }));
    await manager.setAuthPath(auth);
    await writeFile(manager.openCodeGoConfigFile, JSON.stringify(session));
    await manager.savePreset(name);
    assert.equal((await manager.listPresets())[0].name, name);
    assert.deepEqual(JSON.parse(await readFile(join(manager.sidecarsDir, `${name}.json`))), session);
    await manager.switchPreset(name, false);
    assert.equal(manager.config.current_preset, name);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unsafe preset names are rejected before any write', async () => {
  const { dir, manager } = await setup();
  try {
    const auth = join(dir, 'active.json');
    await writeFile(auth, 'active');
    await manager.setAuthPath(auth);
    const configBefore = await readFile(manager.configFile);
    for (const name of ['.', '..', '../escape', 'nested/name', 'nested\\name', 'bad\0name', '\x1bname', '\u0085name', '   ']) {
      await assert.rejects(manager.savePreset(name), /unsafe characters/);
    }
    assert.deepEqual(await readdir(manager.presetsDir), []);
    assert.deepEqual(await readFile(manager.configFile), configBefore);
    assert.deepEqual(await readFile(auth), Buffer.from('active'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
