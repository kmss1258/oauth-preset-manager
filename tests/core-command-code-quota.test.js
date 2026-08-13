import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PresetManager } from '../src/core.js';

test('collectCommandCodeQuota reads oauth.json and parses rolling windows', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opm-command-code-home-'));
  const configDir = await mkdtemp(join(tmpdir(), 'opm-command-code-config-'));
  const authPath = join(home, '.commandcode', 'oauth.json');
  const originalPath = process.env.OPM_COMMAND_CODE_AUTH_PATH;
  process.env.OPM_COMMAND_CODE_AUTH_PATH = authPath;

  try {
    await mkdir(join(home, '.commandcode'), { recursive: true });
    await writeFile(authPath, JSON.stringify({ apiKey: 'user_test-key' }), { mode: 0o600 });

    const requests = [];
    const manager = new PresetManager(configDir);
    manager._requestJson = async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/whoami')) return { org: { id: 'org_test' }, user: { userName: 'tester' } };
      return {
        windowLimits: {
          fiveHour: { used: 2, cap: 10, resetAt: 1770000000000 },
          weekly: { used: 5, cap: 20, resetAt: 1770200000000 },
        },
      };
    };

    const [result] = await manager.collectCommandCodeQuota();

    assert.equal(result.provider, 'commandcode');
    assert.equal(result.account_id, 'org_test');
    assert.equal(result.daily.percent_remaining, 80);
    assert.equal(result.weekly.percent_remaining, 75);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer user_test-key');
    assert.match(result.presets[0], /Command Code: .*oauth\.json/);
  } finally {
    if (originalPath === undefined) delete process.env.OPM_COMMAND_CODE_AUTH_PATH;
    else process.env.OPM_COMMAND_CODE_AUTH_PATH = originalPath;
    await rm(home, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});
