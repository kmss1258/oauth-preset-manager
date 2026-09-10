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
      if (url.includes('/billing/subscriptions')) {
        return { data: { currentPeriodEnd: '2026-09-01T00:00:00.000Z' } };
      }
      if (url.includes('/usage/summary')) {
        return { totalCost: 12.34, totalCount: 42, totalTokens: 123456 };
      }
      return {
        credits: { monthlyCredits: 10, purchasedCredits: 2, freeCredits: 1 },
        windowLimits: {
          fiveHour: { used: 2, cap: 10, resetAt: 1770000000000 },
          weekly: { used: 5, cap: 20, resetAt: '2026-09-01T00:00:00.000Z' },
        },
      };
    };

    const [result] = await manager.collectCommandCodeQuota();

    assert.equal(result.provider, 'commandcode');
    assert.equal(result.account_id, 'org_test');
    assert.equal(result.daily.percent_remaining, 80);
    assert.equal(result.weekly.percent_remaining, 75);
    assert.equal(result.weekly.reset_time_iso, '2026-09-01T00:00:00.000Z');
    assert.equal(requests.length, 4);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer user_test-key');
    assert.equal(result.command_code_credits.total_remaining, 13);
    assert.equal(result.command_code_usage.total_count, 42);
    assert.equal(result.command_code_usage.total_tokens, 123456);
    assert.equal(result.command_code_period.end, '2026-09-01T00:00:00.000Z');
    assert.match(result.presets[0], /Command Code: .*oauth\.json/);
  } finally {
    if (originalPath === undefined) delete process.env.OPM_COMMAND_CODE_AUTH_PATH;
    else process.env.OPM_COMMAND_CODE_AUTH_PATH = originalPath;
    await rm(home, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('Command Code uses a complete persisted snapshot after detail failures', async () => {
  const home = await mkdtemp(join(tmpdir(), 'opm-command-code-cache-home-'));
  const configDir = await mkdtemp(join(tmpdir(), 'opm-command-code-cache-config-'));
  const authPath = join(home, '.commandcode', 'auth.json');
  const originalPath = process.env.OPM_COMMAND_CODE_AUTH_PATH;
  process.env.OPM_COMMAND_CODE_AUTH_PATH = authPath;
  try {
    await mkdir(join(home, '.commandcode'), { recursive: true });
    await writeFile(authPath, JSON.stringify({ apiKey: 'user_cache-key' }), { mode: 0o600 });
    let mode = 'success';
    const manager = new PresetManager(configDir);
    manager.now = () => 1_800_000_000_000;
    manager._requestJson = async url => {
      if (url.endsWith('/whoami')) return { org: { id: 'org_cache' }, user: { userName: 'tester' } };
      if (mode === 'failure') throw Object.assign(new Error('private detail'), { statusCode: 503 });
      if (url.includes('/billing/subscriptions')) return { data: { currentPeriodEnd: '2099-01-01T00:00:00.000Z' } };
      if (url.includes('/usage/summary')) return { totalCost: 1, totalCount: 2, totalTokens: 3 };
      return { credits: { monthlyCredits: 10, purchasedCredits: 2, freeCredits: 1 },
        windowLimits: { fiveHour: { used: 2, cap: 10, resetAt: 1_900_000_000_000 }, weekly: { used: 5, cap: 20, resetAt: 1_900_000_000_000 } } };
    };
    const live = (await manager.collectCommandCodeQuota())[0];
    assert.equal(live.command_code_usage.total_tokens, 3);
    mode = 'failure';
    const cached = (await manager.collectCommandCodeQuota())[0];
    assert.equal(cached.cached, true);
    assert.equal(cached.command_code_usage.total_tokens, 3);
    assert.equal(cached.error, null);

    const restarted = new PresetManager(configDir);
    restarted.now = manager.now;
    restarted._requestJson = async url => {
      if (url.endsWith('/whoami')) return { org: { id: 'org_cache' }, user: { userName: 'tester' } };
      throw Object.assign(new Error('private detail'), { statusCode: 503 });
    };
    const afterRestart = (await restarted.collectCommandCodeQuota())[0];
    assert.equal(afterRestart.cached, true);
    assert.equal(afterRestart.command_code_usage.total_tokens, 3);
  } finally {
    if (originalPath === undefined) delete process.env.OPM_COMMAND_CODE_AUTH_PATH;
    else process.env.OPM_COMMAND_CODE_AUTH_PATH = originalPath;
    await rm(home, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});
