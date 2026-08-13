import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PresetManager } from '../src/core.js';

test('propagateCurrentPresetOAuth adds missing OAuth and skips matching identities', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'opm-propagate-'));
  try {
    const manager = new PresetManager(configDir);
    await manager.init();
    manager.config.current_preset = 'a';
    await manager._saveConfig();
    await writeFile(join(manager.presetsDir, 'a.json'), JSON.stringify({
      openai: { type: 'oauth', access: 'access-a', refresh: 'refresh-a', accountId: 'a' },
      commandcode: { type: 'oauth', access: 'command-access', refresh: 'command-refresh' },
      local: { type: 'api', key: 'do-not-copy' },
    }));
    await writeFile(join(manager.presetsDir, 'b.json'), JSON.stringify({
      codex: { type: 'oauth', access: 'new-access', refresh: 'refresh-a' },
      keep: { type: 'api', key: 'keep' },
    }));
    await writeFile(join(manager.presetsDir, 'c.json'), JSON.stringify({ keep: { type: 'api', key: 'keep' } }));

    const result = await manager.propagateCurrentPresetOAuth();
    const b = JSON.parse(await readFile(join(manager.presetsDir, 'b.json'), 'utf8'));
    const c = JSON.parse(await readFile(join(manager.presetsDir, 'c.json'), 'utf8'));
    assert.deepEqual(result.changed.map(item => item.preset_name), ['b', 'c']);
    assert.deepEqual(result.skipped[0], { preset_name: 'b', services: ['openai'] });
    assert.deepEqual(Object.keys(b), ['codex', 'keep', 'commandcode']);
    assert.deepEqual(Object.keys(c), ['keep', 'openai', 'commandcode']);
    assert.equal(c.openai.refresh, 'refresh-a');
    assert.equal(c.commandcode.refresh, 'command-refresh');
    assert.equal(c.local, undefined);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
