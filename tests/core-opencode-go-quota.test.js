import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PresetManager } from '../src/core.js';

test('collectOpenCodeGoQuota parses all OpenCode Go usage windows', async () => {
  const originalFetch = globalThis.fetch;
  const originalWorkspaceId = process.env.OPENCODE_GO_WORKSPACE_ID;
  const originalAuthCookie = process.env.OPENCODE_GO_AUTH_COOKIE;
  process.env.OPENCODE_GO_WORKSPACE_ID = 'wrk_test123';
  process.env.OPENCODE_GO_AUTH_COOKIE = 'test-cookie';
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => [
      'rollingUsage:$R[1]={usagePercent:20,resetInSec:18000}',
      'weeklyUsage:$R[2]={usagePercent:40,resetInSec:172800}',
      'monthlyUsage:$R[3]={usagePercent:60,resetInSec:2592000}',
    ].join(''),
  });

  try {
    const [result] = await new PresetManager('/tmp/opm-unused-config').collectOpenCodeGoQuota();

    assert.equal(result.provider, 'opencodego');
    assert.equal(result.account_id, 'wrk_test123');
    assert.equal(result.daily.percent_remaining, 80);
    assert.equal(result.weekly.percent_remaining, 60);
    assert.equal(result.monthly_percent, 40);
    assert.ok(result.daily.reset_time_iso);
    assert.ok(result.weekly.reset_time_iso);
    assert.ok(result.monthly_reset_iso);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWorkspaceId === undefined) delete process.env.OPENCODE_GO_WORKSPACE_ID;
    else process.env.OPENCODE_GO_WORKSPACE_ID = originalWorkspaceId;
    if (originalAuthCookie === undefined) delete process.env.OPENCODE_GO_AUTH_COOKIE;
    else process.env.OPENCODE_GO_AUTH_COOKIE = originalAuthCookie;
  }
});

test('collectOpenCodeGoQuota falls back to the local OPM credential config', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'opm-go-config-'));
  const originalFetch = globalThis.fetch;
  const originalWorkspaceId = process.env.OPENCODE_GO_WORKSPACE_ID;
  const originalAuthCookie = process.env.OPENCODE_GO_AUTH_COOKIE;
  delete process.env.OPENCODE_GO_WORKSPACE_ID;
  delete process.env.OPENCODE_GO_AUTH_COOKIE;

  try {
    await writeFile(join(configDir, 'opencode-go.json'), JSON.stringify({
      workspaceId: 'wrk_config123',
      authCookie: 'config-cookie',
    }), { mode: 0o600 });

    let request;
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        text: async () => 'rollingUsage:$R[1]={usagePercent:10,resetInSec:3600}',
      };
    };

    const [result] = await new PresetManager(configDir).collectOpenCodeGoQuota();

    assert.equal(result.account_id, 'wrk_config123');
    assert.equal(result.daily.percent_remaining, 90);
    assert.equal(request.url, 'https://opencode.ai/workspace/wrk_config123/go');
    assert.equal(request.options.headers.Cookie, 'auth=config-cookie');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWorkspaceId === undefined) delete process.env.OPENCODE_GO_WORKSPACE_ID;
    else process.env.OPENCODE_GO_WORKSPACE_ID = originalWorkspaceId;
    if (originalAuthCookie === undefined) delete process.env.OPENCODE_GO_AUTH_COOKIE;
    else process.env.OPENCODE_GO_AUTH_COOKIE = originalAuthCookie;
    await rm(configDir, { recursive: true, force: true });
  }
});
