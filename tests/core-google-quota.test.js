import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PresetManager } from '../src/core.js';

const response = {
  models: {
    'gemini-3-pro-high': {
      displayName: 'Gemini Pro',
      quotaInfo: { remainingFraction: 0, resetTime: '2099-01-01T00:00:00Z' },
    },
    'chat_ignored': { quotaInfo: { remainingFraction: 1, resetTime: '2099-01-01T00:00:00Z' } },
  },
};

test('Google quota persists complete model snapshots and isolates project context', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'opm-google-cache-'));
  try {
    let now = 1_800_000_000_000;
    let failed = false;
    const manager = new PresetManager(configDir);
    manager.now = () => now;
    manager._requestJson = async url => {
      assert.equal(url, 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
      if (failed) throw Object.assign(new Error('private response'), { statusCode: 503 });
      return response;
    };

    const live = (await manager._fetchGoogleQuotaForToken('access-token', null, 'project-a'))[0];
    assert.equal(live.daily.percent_remaining, 0);
    assert.equal(live.daily.label, 'G3Pro');

    failed = true;
    now += 1_000;
    const cached = (await manager._fetchGoogleQuotaForToken('access-token', null, 'project-a'))[0];
    assert.equal(cached.cached, true);
    assert.equal(cached.daily.percent_remaining, 0);
    assert.equal(cached.error, null);

    const restarted = new PresetManager(configDir);
    restarted.now = () => now;
    restarted._requestJson = async () => { throw Object.assign(new Error('private response'), { statusCode: 503 }); };
    const afterRestart = (await restarted._fetchGoogleQuotaForToken('access-token', null, 'project-a'))[0];
    assert.equal(afterRestart.cached, true);
    assert.equal(afterRestart.daily.percent_remaining, 0);

    const otherProject = (await restarted._fetchGoogleQuotaForToken('access-token', null, 'project-b'))[0];
    assert.equal(otherProject.daily, null);
    assert.equal(otherProject.error, 'Google usage unavailable');

    const files = await readdir(join(configDir, 'google-quota-cache'));
    assert.equal(files.length, 2);
    for (const file of files) assert.doesNotMatch(await readFile(join(configDir, 'google-quota-cache', file), 'utf8'), /access-token|private response/);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
