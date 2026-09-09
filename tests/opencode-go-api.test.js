import assert from 'node:assert/strict';
import test from 'node:test';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoQuota, parseGoUsage } from '../src/opencode-go-quota.js';
import { PresetManager } from '../src/core.js';

const usage = () => ({ usage: Object.fromEntries(['rolling', 'weekly', 'monthly'].map((key, index) => [key,
  { status: index === 2 ? 'rate-limited' : 'ok', percent: [20, 40, 100][index], resetsAt: '2026-09-10T03:00:00Z' }])) });

test('Go HTTPS transport uses only official endpoint, bounds bodies, and rejects redirects', async t => {
  const original = https.request; t.after(() => { https.request = original; });
  let status = 200, payload = JSON.stringify(usage()), destroyed = 0, calls = 0;
  https.request = (url, options, callback) => {
    calls++;
    assert.equal(url, 'https://opencode.ai/zen/go/v1/usage');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.timeout, 10000); assert.ok(options.signal);
    const request = new EventEmitter(); request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter(); response.statusCode = status; response.headers = { location: 'https://elsewhere.invalid/' };
      response.destroy = () => { destroyed++; };
      callback(response);
      if (status === 200) { response.emit('data', Buffer.from(payload)); response.emit('end'); }
    };
    return request;
  };
  const quota = new GoQuota();
  assert.equal((await quota.collect('test-key'))[0].daily.percent_remaining, 80);
  status = 302; assert.ok((await quota.collect('test-key'))[0].error); assert.equal(calls, 2); assert.equal(destroyed, 1);
  status = 200; payload = 'x'.repeat(1024 * 1024 + 1);
  assert.ok((await quota.collect('test-key'))[0].error); assert.equal(destroyed, 2);
  payload = '{bad'; assert.ok((await quota.collect('test-key'))[0].error);
});

test('Go parser maps all windows, used percentages, ISO reset and rate-limited 200', () => {
  const parsed = parseGoUsage(usage());
  assert.equal(parsed.daily.percent_remaining, 80); assert.equal(parsed.weekly.percent_remaining, 60);
  assert.equal(parsed.monthly_percent, 0); assert.equal(parsed.daily.reset_time_iso, '2026-09-10T03:00:00.000Z');
  for (const value of [null, '', '20', NaN, Infinity, -1]) {
    const data = usage(); data.usage.rolling.percent = value; assert.throws(() => parseGoUsage(data));
  }
  for (const field of ['status', 'percent', 'resetsAt']) {
    const data = usage(); delete data.usage.weekly[field]; assert.throws(() => parseGoUsage(data));
  }
  const data = usage(); data.usage.monthly.percent = 120; assert.equal(parseGoUsage(data).monthly_percent, 0);
  assert.throws(() => parseGoUsage({ usage: {} }));
});

test('Go errors are redacted and Retry-After cooldown is bound to a hashed key', async () => {
  let now = Date.parse('2026-09-09T00:00:00Z'), calls = 0, status = 429;
  const quota = new GoQuota({ now: () => now, request: async () => {
    calls++; if (status) throw { statusCode: status, retryAfter: '120', message: 'private-secret' }; return usage();
  } });
  assert.match((await quota.collect('key-a'))[0].error, /429/);
  await quota.collect('key-a'); assert.equal(calls, 1);
  assert.ok(!JSON.stringify([...quota.cooldown.keys()]).includes('key-a'));
  await quota.collect('key-b'); assert.equal(calls, 2);
  now += 120001; status = 0;
  assert.equal((await quota.collect('key-a'))[0].daily.percent_remaining, 80);
  for (status of [401, 403, 500]) {
    const row = (await quota.collect('key-a'))[0]; assert.ok(row.error); assert.ok(!JSON.stringify(row).includes('private-secret'));
    if (status !== 500) assert.ok(row.error.includes(String(status)));
  }
  const before = calls; await quota.collect('bad\nkey'); assert.equal(calls, before);
});

test('Go date Retry-After and overlapping requests are coalesced without result aliasing', async () => {
  let resolve, now = Date.parse('2026-09-09T00:00:00Z'), calls = 0;
  const quota = new GoQuota({ now: () => now, request: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const a = quota.collect('key'), b = quota.collect('key'); resolve(usage());
  const [left, right] = await Promise.all([a, b]); assert.equal(calls, 1);
  left[0].daily.percent_remaining = 0; assert.equal(right[0].daily.percent_remaining, 80);
  quota.request = async () => { calls++; throw { statusCode: 429, retryAfter: new Date(now + 180000).toUTCString() }; };
  await quota.collect('key'); now += 120000; await quota.collect('key'); assert.equal(calls, 2);
  now += 60001; await quota.collect('key'); assert.equal(calls, 3);
});

test('Go uses explicit then selected active key and never cookie fallback on key failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'opm-go-api-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = process.env.OPENCODE_GO_API_KEY;
  t.after(() => { if (original == null) delete process.env.OPENCODE_GO_API_KEY; else process.env.OPENCODE_GO_API_KEY = original; });
  const manager = new PresetManager(directory); manager.config = { auth_path: join(directory, 'selected-auth.json') };
  await writeFile(manager.getAuthPath(), JSON.stringify({ 'opencode-go': { type: 'api', key: 'active-key' } }));
  manager._getOpenCodeGoCredentials = () => assert.fail('must not read cookie fallback');
  const keys = []; manager._goQuota = new GoQuota({ request: async key => { keys.push(key); return usage(); } });
  process.env.OPENCODE_GO_API_KEY = 'explicit-key'; await manager.collectOpenCodeGoQuota();
  delete process.env.OPENCODE_GO_API_KEY; await manager.collectOpenCodeGoQuota();
  assert.deepEqual(keys, ['explicit-key', 'active-key']);
  manager._goQuota.request = async () => { throw { statusCode: 403 }; };
  assert.match((await manager.collectOpenCodeGoQuota())[0].error, /403/);
  process.env.OPENCODE_GO_API_KEY = ''; assert.match((await manager.collectOpenCodeGoQuota())[0].error, /401/);
});
