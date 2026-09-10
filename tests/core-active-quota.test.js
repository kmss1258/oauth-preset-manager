import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ActiveQuotaCollector } from '../src/active-quota.js';

const codexUsage = { rate_limit: { primary_window: { used_percent: 23, limit_window_seconds: 18000 } } };
const claudeUsage = { five_hour: { utilization: 41 } };
const row = (provider, status, percent = null, window = '5h', resetAt = null) => ({
  provider, percent, status, ...(status === 'ok' ? { window, resetAt } : {}),
});

async function fixture(t) {
  const homeDir = await mkdtemp(join(tmpdir(), 'opm-active-'));
  const keys = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OPM_CLAUDE_AUTH_PATH'];
  const previous = keys.map(key => process.env[key]);
  keys.forEach(key => { delete process.env[key]; });
  t.after(async () => {
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    await rm(homeDir, { recursive: true, force: true });
  });
  const paths = { codex: join(homeDir, '.codex', 'auth.json'), claude: join(homeDir, '.claude', '.credentials.json') };
  await mkdir(join(homeDir, '.codex'));
  await mkdir(join(homeDir, '.claude'));
  const save = async (provider, fields = {}, root = {}) => writeFile(paths[provider], JSON.stringify(provider === 'codex'
    ? { tokens: { access_token: 'synthetic-codex', account_id: 'synthetic-account', ...fields }, ...root }
    : { claudeAiOauth: { accessToken: 'synthetic-claude', expiresAt: 9e12, ...fields }, ...root }));
  let now = 1_800_000_000_000;
  const calls = [];
  const collector = new ActiveQuotaCollector({ homeDir, now: () => now, requestJson: async (url, options, timeout) => {
    calls.push({ url, options, timeout });
    return url.includes('chatgpt') ? codexUsage : claudeUsage;
  } });
  return { homeDir, paths, save, calls, collector, advance: ms => { now += ms; }, now: () => now };
}

test('fixed native-only results, read-only files, parallel GETs, cache and rotation', async t => {
  const f = await fixture(t);
  await mkdir(join(f.homeDir, '.config', 'oauth-preset-manager', 'presets'), { recursive: true });
  await writeFile(join(f.homeDir, '.config', 'oauth-preset-manager', 'presets', 'ignored.json'), '{"openai":{"access":"do-not-read"}}');
  assert.deepEqual(await f.collector.collect(), [row('codex', 'missing'), row('claude', 'missing')]);
  assert.equal(f.calls.length, 0);
  await f.save('codex'); await f.save('claude');
  const before = await Promise.all(Object.values(f.paths).map(path => readFile(path)));
  const request = f.collector._requestJson;
  const started = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  f.collector._requestJson = async (...args) => {
    started.push(args[0]);
    if (started.length === 2) release();
    await gate;
    return request(...args);
  };
  const expected = [row('codex', 'ok', 77), row('claude', 'ok', 59)];
  const first = await f.collector.collect();
  assert.deepEqual(first, expected);
  first[0].percent = 0;
  assert.deepEqual(await f.collector.collect(), expected);
  assert.equal(f.calls.length, 4);
  for (const { options, timeout } of f.calls) {
    assert.equal(options.method, 'GET'); assert.equal(timeout, 10000);
    assert.ok(options.signal instanceof AbortSignal); assert.equal(options.body, undefined);
  }
  assert.equal(f.calls.find(call => call.url.includes('chatgpt')).options.headers['ChatGPT-Account-Id'], 'synthetic-account');
  assert.deepEqual(await Promise.all(Object.values(f.paths).map(path => readFile(path))), before);
  await f.save('codex', { account_id: 'rotated-account' });
  await f.collector.collect(); assert.equal(f.calls.length, 6);
  f.advance(60000); await f.collector.collect(); assert.equal(f.calls.length, 8);
  await rm(f.paths.codex);
  assert.deepEqual((await f.collector.collect())[0], row('codex', 'missing'));
  assert.deepEqual((await readdir(join(f.homeDir, '.config', 'oauth-preset-manager'))).sort(), ['claude-quota-cache', 'codex-quota-cache', 'presets']);
});

test('unsafe, malformed and oversized credential files fail closed for both providers', async t => {
  const f = await fixture(t);
  for (const provider of ['codex', 'claude']) {
    const index = provider === 'codex' ? 0 : 1;
    for (const content of ['{bad', 'null', '[]', ' '.repeat(1024 * 1024 + 1)]) {
      await writeFile(f.paths[provider], content);
      assert.deepEqual((await f.collector.collect())[index], row(provider, 'error'));
    }
    await rm(f.paths[provider]); await mkdir(f.paths[provider]);
    assert.equal((await f.collector.collect())[index].status, 'error');
    await rm(f.paths[provider], { recursive: true });
    const target = join(f.homeDir, `${provider}-target`);
    await writeFile(target, '{}'); await symlink(target, f.paths[provider]);
    assert.equal((await f.collector.collect())[index].status, 'error');
    await rm(f.paths[provider]);
  }
  assert.equal(f.calls.length, 0);
});

test('native overrides do not fall back, including symlinked ancestors', async t => {
  const f = await fixture(t);
  await f.save('codex'); await f.save('claude');
  process.env.CODEX_HOME = join(f.homeDir, 'absent');
  process.env.CLAUDE_CONFIG_DIR = join(f.homeDir, 'absent');
  assert.deepEqual(await f.collector.collect(), [row('codex', 'missing'), row('claude', 'missing')]);
  const linked = join(f.homeDir, 'linked'); await symlink(join(f.homeDir, '.codex'), linked);
  process.env.CODEX_HOME = linked;
  process.env.OPM_CLAUDE_AUTH_PATH = join(f.paths.claude, 'invalid-child');
  assert.deepEqual(await f.collector.collect(), [row('codex', 'error'), row('claude', 'error')]);
  assert.equal(f.calls.length, 0);
});

test('API key modes, expiry and scope validation never refresh or request', async t => {
  const f = await fixture(t);
  await f.save('codex', {}, { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-synthetic' });
  await f.save('claude', { accessToken: 'sk-ant-api03-synthetic' });
  assert.deepEqual(await f.collector.collect(), [row('codex', 'missing'), row('claude', 'missing')]);
  const jwt = exp => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.c2ln`;
  await f.save('codex', { access_token: jwt(f.now() / 1000) });
  await f.save('claude', { expiresAt: f.now() });
  assert.deepEqual(await f.collector.collect(), [row('codex', 'expired'), row('claude', 'expired')]);
  await f.save('codex', { access_token: jwt('invalid') });
  await f.save('claude', { expiresAt: 'invalid' });
  assert.deepEqual(await f.collector.collect(), [row('codex', 'error'), row('claude', 'error')]);
  await f.save('claude', { scopes: ['user:inference'] });
  assert.equal((await f.collector.collect())[1].status, 'unauthorized');
  assert.equal(f.calls.length, 0);
});

test('429 provider cooldown survives rotation and concurrent polls; Retry-After bounds', async t => {
  for (const retry of ['1', '600', 'invalid', undefined, 'date']) {
    const f = await fixture(t);
    await f.save('codex'); await f.save('claude');
    let calls = 0;
    f.collector._requestJson = async () => {
      calls++;
      throw Object.assign(new Error('synthetic-secret account provider-body'), {
        statusCode: 429, retryAfter: retry === 'date' ? new Date(f.now() + 120000).toUTCString() : retry,
      });
    };
    const expected = [row('codex', 'rate_limited'), row('claude', 'rate_limited')];
    assert.deepEqual(await f.collector.collect(), expected);
    await f.save('codex', { access_token: 'rotated-codex' }); await f.save('claude', { accessToken: 'rotated-claude' });
    assert.deepEqual(await Promise.all([f.collector.collect(), f.collector.collect()]), [expected, expected]);
    const delay = retry === '1' ? 60000 : retry === '600' ? 600000 : retry === 'date' ? 120000 : 300000;
    f.advance(delay - 1); await f.collector.collect(); assert.equal(calls, 2);
    f.advance(1); await f.collector.collect(); assert.equal(calls, 4);
  }
});

test('failure results are redacted, invalidate old percentages and isolate providers', async t => {
  const f = await fixture(t);
  await f.save('codex'); await f.save('claude'); await f.collector.collect();
  for (const statusCode of [401, 403, 500, undefined]) {
    await f.save('codex', { access_token: `rotated-${statusCode}` });
    f.collector._requestJson = async () => { throw Object.assign(new Error('secret provider response'), { statusCode }); };
    assert.deepEqual(await f.collector.collect(), [row('codex', statusCode === 401 || statusCode === 403 ? 'unauthorized' : 'error'),
      { ...row('claude', 'ok', 59), status: 'cached', cachedAt: f.now(),
        cacheError: statusCode === 401 ? 'unauthorized' : statusCode === 403 ? 'unauthorized' : 'error' }]);
  }
});

test('window selection, malformed usage and finite bounds never infer a full quota', async t => {
  const f = await fixture(t);
  await f.save('codex'); await f.save('claude');
  const cases = [
    [{ primary_window: { used_percent: 9 } }, 91, 'quota'],
    [{ primary_window: { used_percent: 9, limit_window_seconds: 604800 }, secondary_window: { used_percent: 30, limit_window_seconds: 18000 } }, 70, '5h'],
    [{ primary_window: { used_percent: 9, limit_window_seconds: 604800 } }, 91, '7d'],
    [{ primary_window: {} }, null],
    [{ primary_window: { used_percent: null } }, null],
    [{ primary_window: { used_percent: '10' } }, null],
    [{ primary_window: { used_percent: Infinity } }, null],
    [{ primary_window: { used_percent: -20 } }, 100],
    [{ primary_window: { used_percent: 150 } }, 0],
  ];
  for (const [rate_limit, percent, window = 'quota'] of cases) {
    f.advance(60000);
    f.collector._requestJson = async url => url.includes('chatgpt') ? { rate_limit } : { seven_day: { utilization: 50 } };
    const [codex, claude] = await f.collector.collect();
    if (percent === null) {
      assert.equal(codex.status, 'cached');
      assert.equal(codex.percent, 91);
      assert.equal(codex.window, '7d');
      assert.equal(codex.cacheError, 'error');
    } else assert.deepEqual(codex, row('codex', 'ok', percent, window));
    assert.deepEqual(claude, row('claude', 'error'));
  }
  f.collector._requestJson = async url => url.includes('chatgpt') ? {} : { limits: [{ kind: 'session', percent: 25 }] };
  const [codex, claude] = await f.collector.collect();
  assert.equal(codex.status, 'cached');
  assert.equal(codex.percent, 0);
  assert.equal(codex.window, 'quota');
  assert.equal(codex.cacheError, 'error');
  assert.deepEqual(claude, row('claude', 'ok', 75));
});

test('reset metadata is finite, cached without drifting, and uses the selected window', async t => {
  const f = await fixture(t);
  await f.save('codex'); await f.save('claude');
  const future = f.now() + 3_600_000;
  const cases = [
    [{ reset_at: future / 1000 }, future],
    [{ reset_at: future }, future],
    [{ resets_at: new Date(future).toISOString() }, future],
    [{ reset_after_seconds: 3600 }, future],
    [{ reset_at: 'bad', reset_after_seconds: 0 }, f.now()],
    [{ reset_at: Infinity, reset_after_seconds: -10 }, null],
    [{ reset_at: 0 }, null],
    [{ reset_at: 1e30 }, null],
    [{ reset_after_seconds: '3600' }, null],
  ];
  for (const [fields, expected] of cases) {
    f.collector._requestJson = async url => url.includes('chatgpt')
      ? { rate_limit: { primary_window: { used_percent: 78, limit_window_seconds: 604800, ...fields } } }
      : { five_hour: { utilization: 40, resets_at: new Date(future).toISOString() } };
    assert.deepEqual(await f.collector.collect({ force: true }), [row('codex', 'ok', 22, '7d', expected), row('claude', 'ok', 60, '5h', future)]);
  }
  f.collector._requestJson = async () => ({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 86400, reset_after_seconds: 3600 } } });
  await f.collector.collect({ force: true });
  f.advance(15000);
  assert.deepEqual((await f.collector.collect())[0], row('codex', 'ok', 99, '24h', f.now() + 3_600_000));
});

test('native Claude uses persisted last success on 429 without borrowing another account', async t => {
  const f = await fixture(t);
  await f.save('claude');
  await f.collector.collect();
  const collector = new ActiveQuotaCollector({ homeDir: f.homeDir, now: f.now,
    requestJson: async () => { throw { statusCode: 429, retryAfter: '600' }; } });
  const expected = { ...row('claude', 'ok', 59), status: 'cached', cachedAt: f.now(), cacheError: 'rate_limited' };
  assert.deepEqual((await collector.collect())[1], expected);
  assert.deepEqual((await collector.collect({ force: true }))[1], expected);
  await f.save('claude', { accessToken: 'another-account' });
  assert.deepEqual((await collector.collect())[1], row('claude', 'rate_limited'));
});

test('manual refresh bypasses successful cache but never 429 cooldown', async t => {
  const f = await fixture(t);
  await f.save('codex'); await f.save('claude');
  await f.collector.collect(); await f.collector.collect({ force: true });
  assert.equal(f.calls.length, 4);
  let calls = 0;
  f.collector._requestJson = async () => { calls++; throw { statusCode: 429 }; };
  await f.collector.collect({ force: true }); await f.collector.collect({ force: true });
  assert.equal(calls, 2);
});

test('default transport records 429 headers before a stalled or aborted body, without network', async t => {
  const f = await fixture(t);
  await f.save('codex');
  const collector = new ActiveQuotaCollector({ homeDir: f.homeDir, now: f.now });
  let calls = 0;
  t.mock.method(https, 'request', (_url, options, callback) => {
    calls++;
    assert.equal(options.timeout, 10000);
    assert.ok(options.signal instanceof AbortSignal);
    const request = new EventEmitter();
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 429; response.headers = { 'retry-after': '600' };
      response.destroy = () => response.emit('aborted');
      callback(response);
    };
    return request;
  });
  assert.deepEqual(await collector.collect(), [row('codex', 'rate_limited'), row('claude', 'missing')]);
  await f.save('codex', { access_token: 'rotated' });
  f.advance(599999); await collector.collect(); assert.equal(calls, 1);
  f.advance(1); await collector.collect(); assert.equal(calls, 2);
});

test('default transport handles success, malformed/oversized bodies, aborts and timeouts without network', async t => {
  const f = await fixture(t);
  await f.save('codex');
  let mode;
  t.mock.method(https, 'request', (_url, _options, callback) => {
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = () => {
      if (mode === 'timeout') { request.emit('timeout'); return; }
      if (mode === 'error') { request.emit('error', new Error('secret')); return; }
      const response = new EventEmitter();
      response.statusCode = 200; response.headers = {};
      response.destroy = () => response.emit('aborted');
      callback(response);
      if (mode === 'aborted') { response.emit('aborted'); return; }
      response.emit('data', Buffer.from(mode === 'ok' ? JSON.stringify(codexUsage)
        : mode === 'oversized' ? ' '.repeat(1024 * 1024 + 1) : '{broken'));
      response.emit('end');
    };
    return request;
  });
  for (mode of ['ok', 'malformed', 'oversized', 'aborted', 'timeout', 'error']) {
    const collector = new ActiveQuotaCollector({ homeDir: f.homeDir });
    const [codex, claude] = await collector.collect();
    assert.deepEqual(codex, mode === 'ok' ? row('codex', 'ok', 77) : {
      ...row('codex', 'ok', 77), status: 'cached', cachedAt: codex.cachedAt, cacheError: 'error',
    });
    assert.deepEqual(claude, row('claude', 'missing'));
  }
});
