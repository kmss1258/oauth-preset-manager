import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getClaudeCodeCredentialsPath, parseClaudeUsage, PresetManager } from '../src/core.js';
import { setLanguage } from '../src/i18n.js';

const usage = {
  five_hour: { utilization: 12.5, resets_at: '2099-09-07T12:00:00Z' },
  seven_day: { utilization: 30, resets_at: '2099-09-12T00:00:00Z' },
  seven_day_sonnet: { utilization: 100, resets_at: null },
  extra_usage: { is_enabled: true, utilization: 24 },
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'opm-claude-'));
  const oldPath = process.env.OPM_CLAUDE_AUTH_PATH;
  process.env.OPM_CLAUDE_AUTH_PATH = join(directory, 'credentials.json');
  t.after(async () => {
    if (oldPath === undefined) delete process.env.OPM_CLAUDE_AUTH_PATH;
    else process.env.OPM_CLAUDE_AUTH_PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  });
  const manager = new PresetManager(join(directory, 'config'));
  await manager.init();
  manager.config.auth_path = join(directory, 'active.json');
  const path = process.env.OPM_CLAUDE_AUTH_PATH;
  const save = async (value = {}) => writeFile(path, JSON.stringify({ claudeAiOauth: {
    accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh',
    expiresAt: Date.now() + 3600_000, scopes: ['user:profile'], ...value,
  } }), { mode: 0o600 });
  return { directory, manager, path, save };
}

test('Claude credential paths honor explicit override and config directory', () => {
  const oldPath = process.env.OPM_CLAUDE_AUTH_PATH;
  const oldDir = process.env.CLAUDE_CONFIG_DIR;
  try {
    delete process.env.OPM_CLAUDE_AUTH_PATH; delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(getClaudeCodeCredentialsPath('/fake'), '/fake/.claude/.credentials.json');
    process.env.CLAUDE_CONFIG_DIR = '/fake/profile';
    assert.equal(getClaudeCodeCredentialsPath('/fake'), '/fake/profile/.credentials.json');
    process.env.OPM_CLAUDE_AUTH_PATH = '/fake/explicit.json';
    assert.equal(getClaudeCodeCredentialsPath('/fake'), '/fake/explicit.json');
  } finally {
    if (oldPath === undefined) delete process.env.OPM_CLAUDE_AUTH_PATH; else process.env.OPM_CLAUDE_AUTH_PATH = oldPath;
    if (oldDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldDir;
  }
});

test('Claude parses legacy and generalized usage without interpreting null as zero usage', () => {
  const parsed = parseClaudeUsage(usage);
  assert.equal(parsed.daily.percent_remaining, 88);
  assert.equal(parsed.weekly.percent_remaining, 70);
  assert.equal(parsed.extra_windows[0].percent_remaining, 0);
  assert.equal(parsed.extra_windows[1].label, 'Extra');
  assert.throws(() => parseClaudeUsage({ five_hour: { utilization: null } }));
  assert.throws(() => parseClaudeUsage('not JSON'));
  assert.throws(() => parseClaudeUsage({ five_hour: { utilization: '10' } }));
  const modern = parseClaudeUsage({ ...usage, limits: [
    { kind: 'session', percent: 20, resets_at: 1800000000 },
    { kind: 'weekly_all', used_percentage: 40, resets_at: 1800000000000 },
    { kind: 'weekly_scoped', group: 'weekly', percent: 60, scope: { model: { display_name: 'Fable' } } },
    { kind: 'weekly_scoped', group: 'weekly', percent: 80, is_active: false },
  ] });
  assert.equal(modern.daily.percent_remaining, 80);
  assert.equal(modern.weekly.percent_remaining, 60);
  assert.equal(modern.daily.reset_time_iso, modern.weekly.reset_time_iso);
  assert.equal(modern.extra_windows[0].label, 'Fable');
  const bounds = parseClaudeUsage({ five_hour: { utilization: 120, resets_at: 'invalid' }, seven_day: { utilization: -5 } });
  assert.equal(bounds.daily.percent_remaining, 0);
  assert.equal(bounds.weekly.percent_remaining, 100);
  assert.equal(bounds.daily.reset_time_iso, null);
});

test('Claude queries OAuth only, deduplicates sources, caches and never rewrites credentials', async t => {
  const { manager, path, save } = await fixture(t);
  await save();
  const original = await readFile(path);
  const auth = { anthropic: { type: 'oauth', access: 'synthetic-access' } };
  await writeFile(manager.getAuthPath(), JSON.stringify(auth));
  await writeFile(join(manager.presetsDir, 'same.json'), JSON.stringify(auth));
  await writeFile(join(manager.presetsDir, 'api.json'), JSON.stringify({ anthropic: { type: 'api', key: 'do-not-send' } }));
  let calls = 0;
  manager._requestJson = async (url, options, timeout) => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-access');
    assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20');
    assert.equal(timeout, 10000);
    return usage;
  };
  const [result] = await manager.collectClaudeCodeQuota();
  assert.equal(result.provider, 'claude');
  assert.equal(result.daily.percent_remaining, 88);
  assert.equal(result.presets.length, 3);
  assert.ok(!JSON.stringify(result).includes('synthetic'));
  await manager.collectClaudeCodeQuota();
  assert.equal(calls, 2);
  assert.deepEqual(await readFile(path), original);
});

test('Claude missing, malformed, symlinked and expired credentials never issue requests', async t => {
  const { manager, path, save, directory } = await fixture(t);
  manager._requestJson = async () => assert.fail('unexpected request');
  assert.deepEqual(await manager.collectClaudeCodeQuota(), []);
  await writeFile(path, '{broken');
  assert.deepEqual(await manager.collectClaudeCodeQuota(), []);
  await save({ expiresAt: 1 });
  assert.ok((await manager.collectClaudeCodeQuota())[0].error);
  await save({ scopes: ['user:inference'] });
  assert.ok((await manager.collectClaudeCodeQuota())[0].error);
  await save({ accessToken: '' });
  assert.deepEqual(await manager.collectClaudeCodeQuota(), []);
  await save({ accessToken: 'sk-ant-api03-synthetic' });
  assert.deepEqual(await manager.collectClaudeCodeQuota(), []);
  await save({ scopes: 'user:profile' });
  assert.ok((await manager.collectClaudeCodeQuota())[0].error);
  await rm(path);
  await writeFile(join(directory, 'target'), JSON.stringify({ claudeAiOauth: { accessToken: 'never-read' } }));
  await symlink(join(directory, 'target'), path);
  await writeFile(join(directory, 'preset-target'), JSON.stringify({ anthropic: { type: 'oauth', access: 'must-not-read' } }));
  await symlink(join(directory, 'preset-target'), join(manager.presetsDir, 'linked.json'));
  assert.deepEqual(await manager.collectClaudeCodeQuota(), []);
});

test('Claude failures redact responses and respect Retry-After cooldown', async t => {
  const { manager, save } = await fixture(t);
  await save();
  let calls = 0;
  manager._requestJson = async () => {
    calls++;
    throw Object.assign(new Error('leaked synthetic-access synthetic-refresh'), { statusCode: 429, retryAfter: '600' });
  };
  setLanguage('en');
  const [result] = await manager.collectClaudeCodeQuota();
  assert.match(result.error, /rate limited/);
  assert.ok(!JSON.stringify(result).includes('synthetic'));
  assert.ok([...manager._claudeQuotaCache.values()][0].until >= Date.now() + 599_000);
  await manager.collectClaudeCodeQuota();
  assert.equal(calls, 1);
  for (const status of [401, 403, 500]) {
    manager._claudeQuotaCache.clear();
    await rm(join(manager.configDir, 'claude-quota-cache'), { recursive: true, force: true });
    manager._requestJson = async () => { throw Object.assign(new Error('synthetic-access'), { statusCode: status }); };
    const [failure] = await manager.collectClaudeCodeQuota();
    assert.ok(failure.error);
    assert.ok(!failure.error.includes('synthetic'));
    assert.equal([...manager._claudeQuotaCache.values()][0].usage, null);
    manager._requestJson = async () => usage;
    assert.equal((await manager.collectClaudeCodeQuota())[0].error, null);
  }
  for (const retryAfter of [new Date(Date.now() + 600_000).toUTCString(), undefined]) {
    manager._claudeQuotaCache.clear();
    await rm(join(manager.configDir, 'claude-quota-cache'), { recursive: true, force: true });
    manager._requestJson = async () => { throw Object.assign(new Error('synthetic-access'), { statusCode: 429, retryAfter }); };
    await manager.collectClaudeCodeQuota();
    const until = [...manager._claudeQuotaCache.values()][0].until;
    assert.ok(until > Date.now() + (retryAfter ? 598_000 : 299_000));
  }
});

test('Claude keeps cached percentages visible after failed probes, including across manager restarts', async t => {
  const { manager, save } = await fixture(t);
  await save();
  manager._requestJson = async () => usage;
  await manager.collectClaudeCodeQuota();
  manager._requestJson = async () => { throw Object.assign(new Error('private failure'), { statusCode: 429 }); };
  const [cached] = await manager.collectClaudeCodeQuota();
  assert.equal(cached.error, null);
  assert.equal(cached.cached, true);
  assert.equal(cached.daily.percent_remaining, 88);
  assert.ok(cached.cached_at && cached.cache_error);
  const restarted = new PresetManager(manager.configDir);
  await restarted.init();
  restarted.config.auth_path = manager.getAuthPath();
  restarted._requestJson = async () => assert.fail('must honor saved 429 cooldown');
  assert.deepEqual((await restarted.collectClaudeCodeQuota())[0], cached);
});

test('distinct Claude OAuth targets remain independent when one request fails', async t => {
  const { manager, save } = await fixture(t);
  await save();
  await writeFile(join(manager.presetsDir, 'second.json'), JSON.stringify({ anthropic: { type: 'oauth', access: 'second-token' } }));
  const calls = [];
  manager._requestJson = async (_url, options) => {
    calls.push(options.headers.Authorization);
    if (options.headers.Authorization.endsWith('second-token')) throw new Error('synthetic failure');
    return usage;
  };
  const results = await manager.collectClaudeCodeQuota();
  assert.equal(results.length, 2);
  assert.notEqual(results[0].account_id, results[1].account_id);
  assert.equal(results.filter(result => !result.error).length, 1);
  assert.equal(calls.length, 2);
});

test('Claude rereads rotated credentials and collectAllQuota includes the provider', async t => {
  const { manager, save } = await fixture(t);
  await save();
  const tokens = [];
  manager._requestJson = async (_url, options) => { tokens.push(options.headers.Authorization); return usage; };
  await manager.collectClaudeCodeQuota();
  await save({ accessToken: 'rotated-synthetic' });
  manager._refreshExpiredOpenAICredentials = async () => [];
  for (const method of ['collectActiveQuota', 'collectOpenAIQuota', 'collectOpenCodeGoQuota', 'collectCommandCodeQuota']) manager[method] = async () => [];
  const all = await manager.collectAllQuota();
  assert.equal(all.length, 1);
  assert.equal(all[0].provider, 'claude');
  assert.deepEqual(tokens, ['Bearer synthetic-access', 'Bearer rotated-synthetic']);
  assert.equal(manager._claudeQuotaCache.size, 1);
});
