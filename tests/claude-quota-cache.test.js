import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { queryClaudeQuota } from '../src/claude-quota-cache.js';

const usage = percent => ({ daily: { label: '5h', percent_remaining: percent, reset_time_iso: '2099-01-01T00:00:00.000Z' },
  weekly: { label: 'Weekly', percent_remaining: 70, reset_time_iso: null }, extra_windows: [] });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'opm-claude-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1_800_000_000_000;
  const options = { token: 'synthetic-oauth-token', directory, memory: new Map(), now: () => now };
  return { options, advance: ms => { now += ms; }, query: (fetchUsage, more = {}) => queryClaudeQuota({ ...options, fetchUsage, ...more }) };
}

test('Claude probes each refresh, retains last success after failures and recovers without stale flags', async t => {
  const f = await fixture(t);
  let calls = 0;
  const fetchUsage = async () => { calls++; return usage(80 - calls); };
  const first = await f.query(fetchUsage);
  assert.equal(first.usage.daily.percent_remaining, 79);
  const second = await f.query(fetchUsage);
  assert.equal(second.usage.daily.percent_remaining, 78);
  assert.equal(calls, 2);
  first.usage.daily.percent_remaining = 0;
  f.advance(60000);
  for (const statusCode of [500, 401, 403, undefined]) {
    const failed = await f.query(async () => { throw Object.assign(new Error('synthetic-oauth-token private-error'), { statusCode }); });
    assert.equal(failed.usage.daily.percent_remaining, 78);
    assert.equal(failed.fetchedAt, second.fetchedAt);
    assert.ok(failed.errorCode);
  }
  const recovered = await f.query(fetchUsage);
  assert.equal(recovered.errorCode, null);
  assert.equal(recovered.usage.daily.percent_remaining, 77);
  const files = await readdir(f.options.directory);
  assert.equal(files.length, 1);
  const content = await readFile(join(f.options.directory, files[0]), 'utf8');
  assert.doesNotMatch(content, /synthetic|private-error|accessToken|Authorization/);
  assert.equal((await stat(join(f.options.directory, files[0]))).mode & 0o777, 0o600);
});

test('429 fallback and cooldown survive a new cache instance; retry resumes after Retry-After', async t => {
  const f = await fixture(t);
  const first = await f.query(async () => usage(60));
  const rateLimit = async () => { throw { statusCode: 429, retryAfter: '600' }; };
  const cached = await f.query(rateLimit);
  assert.equal(cached.errorCode, 'rate_limited');
  assert.equal(cached.usage.daily.percent_remaining, 60);
  assert.equal(cached.fetchedAt, first.fetchedAt);
  const restarted = await f.query(() => assert.fail('must honor stored cooldown'), { memory: new Map() });
  assert.deepEqual(restarted, cached);
  f.advance(600000);
  const recovered = await f.query(async () => usage(55), { memory: new Map() });
  assert.equal(recovered.usage.daily.percent_remaining, 55);
  assert.equal(recovered.errorCode, null);
});

test('cache never crosses tokens and ignores snapshots older than 24 hours', async t => {
  const f = await fixture(t);
  await f.query(async () => usage(60));
  const fail = async () => { throw new Error('private'); };
  assert.equal((await f.query(fail, { token: 'another-account' })).usage, null);
  f.advance(24 * 3600000 + 1);
  assert.equal((await f.query(fail)).usage, null);
});

test('table and sidebar coalesce overlapping requests, without sharing result objects', async t => {
  const f = await fixture(t);
  let finish;
  const first = f.query(() => new Promise(resolve => { finish = resolve; }));
  const second = f.query(() => assert.fail('duplicate query'), { memory: new Map() });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  finish(usage(30));
  const [a, b] = await Promise.all([first, second]);
  a.usage.daily.percent_remaining = 0;
  assert.equal(b.usage.daily.percent_remaining, 30);
});

test('corrupt or symlinked cache cannot overwrite another file or suppress a live request', async t => {
  const f = await fixture(t);
  await f.query(async () => usage(70));
  const [name] = await readdir(f.options.directory), path = join(f.options.directory, name);
  await writeFile(path, '{bad');
  assert.equal((await f.query(async () => usage(50), { memory: new Map() })).usage.daily.percent_remaining, 50);
  await rm(path);
  const target = join(f.options.directory, 'target'); await writeFile(target, 'preserve'); await symlink(target, path);
  assert.equal((await f.query(async () => usage(40), { memory: new Map() })).usage.daily.percent_remaining, 40);
  assert.equal(await readFile(target, 'utf8'), 'preserve');
});
