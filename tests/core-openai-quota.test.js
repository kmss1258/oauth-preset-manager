import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PresetManager } from '../src/core.js';

function makeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

test('OpenAI quota uses live wham plan_type for Pro detection metadata', async () => {
  const manager = new PresetManager('/tmp/opm-unused-config');
  const access = makeJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-live',
      chatgpt_plan_type: 'plus',
    },
  });

  manager._requestJson = async () => ({
    plan_type: 'pro',
    rate_limit: {
      primary_window: { used_percent: 40, reset_after_seconds: 3600 },
      secondary_window: { used_percent: 10, reset_after_seconds: 7200 },
    },
  });

  const result = await manager._fetchOpenAIQuotaForToken(access, Date.now() + 60_000, null, 10, 'plus');

  assert.equal(result.provider, 'openai');
  assert.equal(result.account_id, 'acct-live');
  assert.equal(result.plan_type, 'pro');
  assert.equal(result.plan_type_source, 'usage');
  assert.equal(result.daily.percent_remaining, 60);
  assert.equal(result.weekly.percent_remaining, 90);
  assert.equal(result.error, null);
});

test('expired OpenAI tokens keep auth plan metadata but remain ineligible for rainbow UI', async () => {
  const manager = new PresetManager('/tmp/opm-unused-config');

  const result = await manager._fetchOpenAIQuotaForToken('expired-token', Date.now() - 1, 'acct-expired', 10, 'pro');

  assert.equal(result.provider, 'openai');
  assert.equal(result.account_id, 'acct-expired');
  assert.equal(result.plan_type, 'pro');
  assert.equal(result.plan_type_source, 'auth');
  assert.equal(result.error, 'Token expired');
});

test('collectAllQuota refreshes expired OpenAI presets in parallel and persists rotated tokens', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'opm-openai-refresh-'));

  try {
    const manager = new PresetManager(configDir);
    await manager.init();
    const activeAuthPath = join(configDir, 'missing-auth.json');
    manager.getAuthPath = () => activeAuthPath;
    manager.collectActiveQuota = async () => [];

    const expired = Date.now() - 1_000;
    const presets = [
      ['alpha', 'openai', 'refresh-a'],
      ['alpha-copy', 'codex', 'refresh-a'],
      ['beta', 'openai', 'refresh-b'],
    ];

    for (const [name, service, refresh] of presets) {
      await writeFile(join(manager.presetsDir, `${name}.json`), JSON.stringify({
        [service]: {
          type: 'oauth',
          access: `expired-${refresh}`,
          refresh,
          expires: expired,
          accountId: `account-${refresh}`,
        },
        keep: { name },
      }, null, 2));
    }

    const refreshCalls = [];
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;
    manager._requestJson = async (url, options) => {
      if (url.endsWith('/oauth/token')) {
        const refresh = new URLSearchParams(options.body).get('refresh_token');
        refreshCalls.push(refresh);
        activeRefreshes += 1;
        maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
        await new Promise(resolve => setTimeout(resolve, 20));
        activeRefreshes -= 1;
        return {
          access_token: `access-${refresh}`,
          refresh_token: `rotated-${refresh}`,
          expires_in: 3600,
        };
      }

      if (url.includes('/wham/usage')) {
        return {
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 10, reset_after_seconds: 3600 },
            secondary_window: { used_percent: 20, reset_after_seconds: 7200 },
          },
        };
      }

      throw new Error(`Unexpected request: ${url}`);
    };

    const results = await manager.collectAllQuota();

    assert.deepEqual(refreshCalls.sort(), ['refresh-a', 'refresh-b']);
    assert.equal(maxActiveRefreshes, 2);
    assert.equal(results.length, 2);
    assert.ok(results.every(result => result.error === null));

    const alpha = JSON.parse(await readFile(join(manager.presetsDir, 'alpha.json'), 'utf-8'));
    const alphaCopy = JSON.parse(await readFile(join(manager.presetsDir, 'alpha-copy.json'), 'utf-8'));
    const beta = JSON.parse(await readFile(join(manager.presetsDir, 'beta.json'), 'utf-8'));

    assert.equal(alpha.openai.access, 'access-refresh-a');
    assert.equal(alpha.openai.refresh, 'rotated-refresh-a');
    assert.ok(alpha.openai.expires > Date.now());
    assert.equal(alpha.keep.name, 'alpha');
    assert.equal(alphaCopy.codex.access, 'access-refresh-a');
    assert.equal(alphaCopy.codex.refresh, 'rotated-refresh-a');
    assert.equal(beta.openai.access, 'access-refresh-b');
    assert.equal(beta.openai.refresh, 'rotated-refresh-b');
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
