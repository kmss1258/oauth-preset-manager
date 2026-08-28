import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PresetManager } from '../src/core.js';

async function setupPresets(presets) {
  const configDir = await mkdtemp(join(tmpdir(), 'opm-propagate-'));
  const manager = new PresetManager(configDir);
  await manager.init();
  manager.config.current_preset = 'source';
  await manager._saveConfig();
  for (const [name, data] of Object.entries(presets)) {
    await writeFile(join(manager.presetsDir, `${name}.json`), JSON.stringify(data));
  }
  return { configDir, manager };
}

async function readPreset(manager, name) {
  return JSON.parse(await readFile(join(manager.presetsDir, `${name}.json`), 'utf8'));
}

test('replaces selected eligible entries, preserves unrelated services, and excludes source', async () => {
  const { configDir, manager } = await setupPresets({
    source: {
      openai: { type: 'oauth', access: 'source-access', refresh: 'source-refresh' },
      commandcode: { type: 'oauth', access: 'command-access', refresh: 'command-refresh' },
      local: { type: 'api', key: 'source-local' },
    },
    selected: {
      openai: { type: 'oauth', access: 'old-access', refresh: 'old-refresh' },
      codex: { type: 'oauth', access: 'old-codex', refresh: 'old-codex-refresh' },
      keep: { type: 'api', key: 'keep' },
    },
    unselected: { openai: { type: 'oauth', access: 'untouched', refresh: 'untouched' } },
  });
  try {
    const sourceBytes = await readFile(join(manager.presetsDir, 'source.json'), 'utf8');
    const selectedBytes = await readFile(join(manager.presetsDir, 'selected.json'), 'utf8');
    const result = await manager.distributeCurrentPresetCredentials({ authServiceKeys: ['openai', 'commandcode'], targetNames: ['source', 'selected', 'selected'] });
    const selected = await readPreset(manager, 'selected');
    const unselected = await readPreset(manager, 'unselected');

    assert.equal(result.source_preset, 'source');
    assert.equal(result.source_entries, 2);
    assert.deepEqual(result.changed.map(item => item.preset_name), ['selected']);
    assert.deepEqual(result.changed[0].services, ['commandcode', 'openai']);
    assert.deepEqual(result.unchanged, []);
    assert.deepEqual(selected, {
      keep: { type: 'api', key: 'keep' },
      openai: { type: 'oauth', access: 'source-access', refresh: 'source-refresh' },
      commandcode: { type: 'oauth', access: 'command-access', refresh: 'command-refresh' },
      codex: { type: 'oauth', access: 'old-codex', refresh: 'old-codex-refresh' },
    });
    assert.deepEqual(unselected, { openai: { type: 'oauth', access: 'untouched', refresh: 'untouched' } });
    assert.equal(await readFile(result.changed[0].backup_path, 'utf8'), selectedBytes);
    assert.equal(await readFile(join(manager.presetsDir, 'source.json'), 'utf8'), sourceBytes);
    assert.equal((await readdir(manager.backupsDir)).some(name => name.includes('_source_')), false);
    assert.equal((await readdir(manager.backupsDir)).length, 1);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('empty targets do nothing', async () => {
  const { configDir, manager } = await setupPresets({ source: { openai: { type: 'oauth', refresh: 'r' } }, target: { keep: { type: 'api' } } });
  try {
    const before = await readPreset(manager, 'target');
    const result = await manager.distributeCurrentPresetCredentials({ authServiceKeys: ['openai'], targetNames: [] });
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.unchanged, []);
    assert.deepEqual(await readPreset(manager, 'target'), before);
    assert.deepEqual(await readdir(manager.backupsDir), []);
  } finally { await rm(configDir, { recursive: true, force: true }); }
});

test('zero eligible source entries clears nothing', async () => {
  const { configDir, manager } = await setupPresets({ source: { local: { type: 'api' } }, target: { openai: { type: 'oauth', refresh: 'old' }, keep: { type: 'api' } } });
  try {
    const before = await readPreset(manager, 'target');
    const result = await manager.distributeCurrentPresetCredentials({ targetNames: ['target'] });
    assert.equal(result.source_entries, 0);
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.unchanged, [{ preset_name: 'target' }]);
    assert.deepEqual(await readPreset(manager, 'target'), before);
    assert.deepEqual(await readdir(manager.backupsDir), []);
  } finally { await rm(configDir, { recursive: true, force: true }); }
});

test('identical replacement skips backup and write', async () => {
  const { configDir, manager } = await setupPresets({
    source: { openai: { type: 'oauth', refresh: 'same' }, keep: { type: 'api' } },
    target: { openai: { type: 'oauth', refresh: 'same' }, keep: { type: 'api' } },
  });
  try {
    const result = await manager.distributeCurrentPresetCredentials({ authServiceKeys: ['openai'], targetNames: ['target'] });
    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.unchanged, [{ preset_name: 'target' }]);
    assert.deepEqual(await readdir(manager.backupsDir), []);
  } finally { await rm(configDir, { recursive: true, force: true }); }
});

test('unknown targets are validated before any writes', async () => {
  const { configDir, manager } = await setupPresets({ source: { openai: { type: 'oauth', refresh: 'new' } }, target: { openai: { type: 'oauth', refresh: 'old' } } });
  try {
    await assert.rejects(manager.distributeCurrentPresetCredentials({ authServiceKeys: ['openai'], targetNames: ['target', 'missing'] }), /Preset not found: missing/);
    assert.equal((await readPreset(manager, 'target')).openai.refresh, 'old');
    assert.deepEqual(await readdir(manager.backupsDir), []);
  } finally { await rm(configDir, { recursive: true, force: true }); }
});

test('rejects non-array targets', async () => {
  const { configDir, manager } = await setupPresets({ source: { openai: { type: 'oauth', refresh: 'new' } } });
    try { await assert.rejects(manager.propagateCurrentPresetOAuth('target'), /must be an array/); }
  finally { await rm(configDir, { recursive: true, force: true }); }
});

test('rejects array-shaped source or target before writes and preserves active auth/config', async () => {
  for (const presets of [
    { source: [], target: { openai: { type: 'oauth', refresh: 'old' } } },
    { source: { openai: { type: 'oauth', refresh: 'new' } }, target: [] },
  ]) {
    const { configDir, manager } = await setupPresets(presets);
    try {
      const activePath = join(configDir, 'active-auth.json');
      await writeFile(activePath, '{"active":true}');
      await manager.setAuthPath(activePath);
      const activeBytes = await readFile(activePath, 'utf8');
      const configBytes = await readFile(manager.configFile, 'utf8');
      await assert.rejects(manager.distributeCurrentPresetCredentials({ authServiceKeys: ['openai'], targetNames: ['target'] }), /plain object/);
      assert.equal(await readFile(activePath, 'utf8'), activeBytes);
      assert.equal(await readFile(manager.configFile, 'utf8'), configBytes);
      assert.deepEqual(await readdir(manager.backupsDir), []);
    } finally { await rm(configDir, { recursive: true, force: true }); }
  }
});

test('keeps target unchanged when atomic write fails and retains exact backup', async () => {
  const { configDir, manager } = await setupPresets({
    source: { openai: { type: 'oauth', refresh: 'new' } },
    target: { openai: { type: 'oauth', refresh: 'old' }, keep: { type: 'api' } },
  });
  try {
    const activePath = join(configDir, 'active-auth.json');
    await writeFile(activePath, '{"active":true}');
    await manager.setAuthPath(activePath);
    const targetBytes = await readFile(join(manager.presetsDir, 'target.json'), 'utf8');
    const activeBytes = await readFile(activePath, 'utf8');
    const configBytes = await readFile(manager.configFile, 'utf8');
    manager._writeJsonAtomic = async () => { throw new Error('injected write failure'); };

    await assert.rejects(manager.distributeCurrentPresetCredentials({ authServiceKeys: ['openai'], targetNames: ['target'] }), /injected write failure/);
    const backups = await readdir(manager.backupsDir);
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(manager.backupsDir, backups[0]), 'utf8'), targetBytes);
    assert.equal(await readFile(join(manager.presetsDir, 'target.json'), 'utf8'), targetBytes);
    assert.equal(await readFile(activePath, 'utf8'), activeBytes);
    assert.equal(await readFile(manager.configFile, 'utf8'), configBytes);
  } finally { await rm(configDir, { recursive: true, force: true }); }
});

test('repeated overwrites use distinct backup paths', async () => {
  const { configDir, manager } = await setupPresets({
    source: { openai: { type: 'oauth', refresh: 'new' } },
    target: { openai: { type: 'oauth', refresh: 'old' } },
  });
  try {
    const first = await manager.distributeCurrentPresetCredentials({ authServiceKeys: ['openai'], targetNames: ['target'] });
    await writeFile(join(manager.presetsDir, 'target.json'), JSON.stringify({ openai: { type: 'oauth', refresh: 'old-again' } }));
    const second = await manager.distributeCurrentPresetCredentials({ authServiceKeys: ['openai'], targetNames: ['target'] });
    assert.notEqual(first.changed[0].backup_path, second.changed[0].backup_path);
    assert.equal((await readdir(manager.backupsDir)).length, 2);
  } finally { await rm(configDir, { recursive: true, force: true }); }
});

test('legacy propagation only includes OAuth entries with a usable identity or Command Code credentials', async () => {
  const { configDir, manager } = await setupPresets({
    source: {
      empty_oauth: { type: 'oauth', refresh: '' },
      access_oauth: { type: 'oauth', access: 'access' },
      api: { type: 'api', key: 'api' },
      'command-code': { type: 'api', key: 'command' },
    },
    target: {
      empty_oauth: { type: 'oauth', refresh: 'old' },
      access_oauth: { type: 'oauth', refresh: 'old-access' },
      api: { type: 'api', key: 'old-api' },
      'command-code': { type: 'api', key: 'old-command' },
    },
  });
  try {
    await manager.propagateCurrentPresetOAuth(['target']);
    const target = await readPreset(manager, 'target');
    assert.equal(target.empty_oauth.refresh, 'old');
    assert.equal(target.access_oauth.access, 'access');
    assert.equal(target.api.key, 'old-api');
    assert.equal(target['command-code'].key, 'command');
  } finally { await rm(configDir, { recursive: true, force: true }); }
});
