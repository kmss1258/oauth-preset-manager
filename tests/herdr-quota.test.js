import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import TOML from '@iarna/toml';
import stringWidth from 'string-width';
import { addQuotaRows, acquireHerdrLock, ensureHerdrQuotaConfig, HERDR_QUOTA_TOKENS } from '../src/herdr-config.js';
import { compactReset, formatHerdrQuota, startHerdrQuota } from '../src/herdr-quota.js';
import { SystemMetrics } from '../src/system-metrics.js';
import { SIDEBAR_DEFAULTS } from '../src/sidebar-settings.js';

async function directory(t) {
  const home = await mkdtemp(join(tmpdir(), 'opm-herdr-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function until(predicate) {
  for (let n = 0; n < 300; n++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Expected Herdr state was not reached');
}

const usage = now => [
  { provider: 'codex', status: 'ok', percent: 62, window: '5h', resetAt: now + 8_040_000 },
  { provider: 'claude', status: 'ok', percent: 38, window: '5h', resetAt: now + 2_820_000 },
];

test('compact rows have fixed identities, honest boundaries and no terminal escapes', () => {
  const now = 1_800_000_000_000;
  assert.equal(formatHerdrQuota(usage(now)[0], now), 'CX ▰▰▱▱ 62% 2h14m');
  assert.equal(formatHerdrQuota(usage(now)[1], now), 'CC ▰▰▱▱ 38% 47m');
  assert.equal(formatHerdrQuota({ ...usage(now)[1], status: 'cached' }, now), 'CC* ▰▰▱▱ 38% 47m');
  assert.equal(formatHerdrQuota({ ...usage(now)[0], window: '7d', percent: 0 }, now), 'CX 7d ▱▱▱▱ 0% 2h14m');
  assert.match(formatHerdrQuota({ ...usage(now)[0], percent: 100 }, now), /▰▰▰▰ 100%/);
  for (const [delta, expected] of [[-1, 'reset'], [0, 'reset'], [1, '<1m'], [59999, '<1m'], [60000, '1m'], [3_600_000, '1h0m'], [97_200_000, '1d3h']]) {
    assert.equal(compactReset(now + delta, now), expected);
  }
  for (const bad of [null, undefined, NaN, Infinity, 0, -1]) assert.equal(compactReset(bad, now), '-');
  for (const status of ['loading', 'missing', 'expired', 'unauthorized', 'rate_limited', 'error', '\x1b[31msecret']) {
    const line = formatHerdrQuota({ ...usage(now)[0], status }, now);
    assert.ok(!line.includes('%') && !line.includes('\x1b') && !line.includes('secret'));
    assert.ok(stringWidth(line) <= 24);
  }
});

test('Space config preserves comments, unrelated settings, existing rows and idempotence', () => {
  const configs = [
    '',
    '# my keys\n[keys]\nprefix = "f1"\n[theme]\nname = "gruvbox"\n',
    '[ui.sidebar.spaces]\nrow_gap = 1\n',
    '[ui.sidebar.spaces]\nrows = []\n',
    '[ui.sidebar.spaces]\nrows = [["workspace"]]\n[ui.sound]\nenabled = true\n',
    '[ui.sidebar.spaces] # comment\nrows = [\n ["workspace"], # keep this\n [{token="$custom", fg="#abc"}],\n]\n',
    '[ui.sidebar.spaces]\nrows = [["workspace"] # keep without trailing comma\n]\n',
    '[ui.sidebar.spaces]\nrows = [[{ token="$opm_cx", fg="#fff" }]]\n',
    '# [ui.sidebar.spaces]\n[ui]\nsidebar_width=32\n',
    '[ui.sidebar.spaces]\nrows = [ ["workspace", "$opm_cx", "$opm_cc"] ]\n',
  ];
  for (const original of configs) {
    const output = addQuotaRows(original);
    assert.equal(addQuotaRows(output), output);
    const before = TOML.parse(original);
    const after = TOML.parse(output);
    const rows = after.ui.sidebar.spaces.rows;
    for (const { token } of HERDR_QUOTA_TOKENS) assert.ok(rows.flat().some(value => (value.token || value) === token));
    if (before.ui?.sidebar?.spaces?.rows) assert.deepEqual(rows.slice(0, before.ui.sidebar.spaces.rows.length), before.ui.sidebar.spaces.rows);
    if (original.includes('keep this')) assert.ok(output.includes('# keep this'));
    if (before.keys) assert.deepEqual(after.keys, before.keys);
    if (before.theme) assert.deepEqual(after.theme, before.theme);
    if (before.ui?.sound) assert.deepEqual(after.ui.sound, before.ui.sound);
  }
  for (const original of ['[bad', '[ui.sidebar.spaces]\nrows=42', 'ui={sidebar={spaces={rows=[["workspace"]]}}}']) {
    assert.throws(() => addQuotaRows(original));
  }
});

test('config installation validates before writing, backs up exact bytes and preserves permissions', async t => {
  const home = await directory(t), path = join(home, 'config.toml');
  const original = '# original\n[keys]\nprefix="f1"\n';
  await writeFile(path, original); await chmod(path, 0o640); await chmod(home, 0o750);
  const calls = [];
  const run = async (args, env) => {
    calls.push(args.join(' '));
    if (args[0] === 'config') {
      assert.equal(await readFile(path, 'utf8'), original);
      assert.ok(TOML.parse(await readFile(env.HERDR_CONFIG_PATH, 'utf8')).ui.sidebar.spaces.rows);
    }
  };
  assert.equal(await ensureHerdrQuotaConfig(path, run), true);
  assert.deepEqual(calls, ['config check', 'server reload-config']);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  assert.equal((await stat(home)).mode & 0o777, 0o750);
  const backups = (await readdir(home)).filter(name => name.includes('.opm-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(home, backups[0]), 'utf8'), original);
  assert.equal(await ensureHerdrQuotaConfig(path, run), false);
  assert.equal(calls.length, 2);
  assert.equal((await readdir(home)).some(name => name.endsWith('.tmp') || name.endsWith('.opm-lock')), false);
});

test('config failures fail closed and reload failure rolls back, never overwriting an intervening edit', async t => {
  const home = await directory(t), path = join(home, 'config.toml');
  const original = '[keys]\nprefix="f1"\n';
  await writeFile(path, original);
  await assert.rejects(ensureHerdrQuotaConfig(path, async () => { throw new Error('reject'); }), /reject/);
  assert.equal(await readFile(path, 'utf8'), original);
  await assert.rejects(ensureHerdrQuotaConfig(path, async args => {
    if (args[0] === 'server') throw new Error('reload rejected');
  }), /reload rejected/);
  assert.equal(await readFile(path, 'utf8'), original);
  await assert.rejects(ensureHerdrQuotaConfig(path, async args => {
    if (args[0] === 'server') { await writeFile(path, '# user edit\n'); throw new Error('rejected'); }
  }));
  assert.equal(await readFile(path, 'utf8'), '# user edit\n');
  await writeFile(path, '[bad');
  await assert.rejects(ensureHerdrQuotaConfig(path, async () => assert.fail('must not execute')));
  assert.equal(await readFile(path, 'utf8'), '[bad');
  const invalidUtf8 = Buffer.concat([Buffer.from('[theme]\nname="'), Buffer.from([0xff]), Buffer.from('"\n')]);
  await writeFile(path, invalidUtf8);
  await assert.rejects(ensureHerdrQuotaConfig(path, async () => assert.fail('must not execute')));
  assert.deepEqual(await readFile(path), invalidUtf8);
  await rm(path); await symlink(join(home, 'target'), path);
  await assert.rejects(ensureHerdrQuotaConfig(path, async () => assert.fail('must not execute')));
});

test('only one live owner acquires a resource, dead owners recover and release cannot delete a successor', async t => {
  const home = await directory(t), path = join(home, 'owner.lock');
  const release = await acquireHerdrLock(path);
  assert.ok(release);
  assert.equal(await acquireHerdrLock(path), null);
  await release();
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  await writeFile(path, JSON.stringify({ pid: child.pid, nonce: 'dead' }));
  const claims = await Promise.all(Array.from({ length: 8 }, () => acquireHerdrLock(path)));
  assert.equal(claims.filter(Boolean).length, 1);
  await release();
  assert.equal(await acquireHerdrLock(path), null);
  await claims.find(Boolean)();
  assert.ok(!(await readdir(home)).some(name => name.endsWith('.lock')));
});

async function fixture(t) {
  const home = await directory(t), socket = join(home, 'herdr.sock');
  const server = createServer(connection => connection.end());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  let now = 1_800_000_000_000;
  let workspace = 'wHome';
  const calls = [], fetches = [], metadata = new Map();
  const config = join(home, 'config.toml');
  await writeFile(config, '[keys]\nprefix="f1"\n');
  const run = async (args, overrides) => {
    calls.push(args);
    if (args[0] === 'pane') return JSON.stringify({ result: { pane: { workspace_id: workspace } } });
    if (args[0] === 'config') TOML.parse(await readFile(overrides.HERDR_CONFIG_PATH, 'utf8'));
    if (args[0] === 'workspace') {
      const current = metadata.get(args[2]) || {};
      for (let n = 0; n < args.length; n++) {
        if (args[n] === '--token') {
          const [name, value] = args[++n].split('='); current[name] = { value, expires: now + Number(args.at(-1)) };
        } else if (args[n] === '--clear-token') delete current[args[++n]];
      }
      metadata.set(args[2], current);
    }
    return '';
  };
  const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'wHome:p1', HERDR_WORKSPACE_ID: 'wrong-inherited-workspace',
    HERDR_SOCKET_PATH: socket, HERDR_CONFIG_PATH: config };
  const collector = { collect: async options => { fetches.push(options); return usage(now); } };
  const options = { interactive: true, env, homeDir: home, run, collector, now: () => now, tickMs: 100000,
    settingsStore: { load: async () => ({ ...SIDEBAR_DEFAULTS, disk: false, ram: false, gpu: false }) },
    metrics: new SystemMetrics({ disk: () => assert.fail('disk disabled'), ram: () => assert.fail('RAM disabled'), gpu: () => assert.fail('GPU disabled') }),
  };
  const displays = [];
  t.after(async () => { for (const display of displays) await display.stop(); });
  return { home, calls, fetches, metadata, collector, env, options,
    start(extra = {}) { const display = startHerdrQuota({ ...options, ...extra }); displays.push(display); return display; },
    advance(ms) { now += ms; }, move(value) { workspace = value; },
  };
}

test('outside Herdr, non-TTY, or missing caller context performs no I/O', async t => {
  const home = await directory(t);
  for (const extra of [{ interactive: false }, { env: {} }, { env: { HERDR_ENV: '1' } }]) {
    const display = startHerdrQuota({ interactive: true, env: { HERDR_ENV: '1', HERDR_PANE_ID: 'p1', HERDR_SOCKET_PATH: '/no/socket' },
      homeDir: home, run: () => assert.fail('no subprocess'), collector: { collect: () => assert.fail('no network') }, ...extra });
    await display.ready; display.refresh(); await display.stop();
  }
  assert.deepEqual(await readdir(home), []);
});

test('HOME use targets the caller Space, updates countdown without fetching and clears on exit', async t => {
  const f = await fixture(t), display = f.start();
  await until(() => f.metadata.get('wHome')?.opm_cx?.value.includes('62%'));
  assert.equal(f.metadata.has('wrong-inherited-workspace'), false);
  assert.deepEqual(f.fetches, [{ force: false, providers: ['codex', 'claude'] }]);
  assert.ok(f.calls.filter(args => args[0] === 'pane').every(args => args.join(' ') === 'pane current --current'));
  const before = f.metadata.get('wHome').opm_cx.expires;
  f.advance(15_000); await display.tick();
  assert.match(f.metadata.get('wHome').opm_cx.value, /2h13m/);
  assert.ok(f.metadata.get('wHome').opm_cx.expires > before);
  assert.equal(f.fetches.length, 1);
  display.refresh(true);
  await until(() => f.fetches.length === 2 && !display.pending);
  assert.deepEqual(f.fetches[1], { force: true, providers: ['codex', 'claude'] });
  f.advance(60_000); await display.tick();
  await until(() => f.fetches.length === 3 && !display.pending);
  await display.stop();
  assert.deepEqual(f.metadata.get('wHome'), {});
  const count = f.calls.length;
  display.refresh(); await display.tick(); await display.stop();
  assert.equal(f.calls.length, count);
});

test('same Space has one reporter; a waiting instance takes over, while another Space is independent', async t => {
  const f = await fixture(t), first = f.start();
  await until(() => f.metadata.get('wHome')?.opm_cx?.value.includes('62%'));
  const second = f.start(); await second.ready;
  assert.equal(f.fetches.length, 1);
  await first.stop(); await second.tick();
  await until(() => f.fetches.length === 2 && !second.pending);
  assert.match(f.metadata.get('wHome').opm_cx.value, /62%/);
  const other = f.start({ run: async (args, env) => args[0] === 'pane'
    ? JSON.stringify({ result: { pane: { workspace_id: 'wOther' } } }) : f.options.run(args, env) });
  await until(() => f.metadata.get('wOther')?.opm_cc?.value.includes('38%'));
  await second.stop();
  assert.match(f.metadata.get('wOther').opm_cc.value, /38%/);
  await other.stop();
});

test('closing a non-owner does not clear the owner and pane moves release old Space tokens', async t => {
  const f = await fixture(t), first = f.start();
  await until(() => f.metadata.get('wHome')?.opm_cx?.value.includes('62%'));
  const second = f.start(); await second.ready; await second.stop();
  assert.match(f.metadata.get('wHome').opm_cx.value, /62%/);
  f.move('wMoved'); await first.tick();
  assert.deepEqual(f.metadata.get('wHome'), {});
  assert.match(f.metadata.get('wMoved').opm_cx.value, /62%/);
});

test('provider failure removes stale percentages; stop never republishes a late result', async t => {
  const f = await fixture(t), display = f.start();
  await until(() => f.metadata.get('wHome')?.opm_cx?.value.includes('62%'));
  f.collector.collect = async () => { throw new Error('private provider body'); };
  display.refresh(true);
  await until(() => f.metadata.get('wHome')?.opm_cx?.value === 'CX error' && !display.pending);
  let complete;
  f.collector.collect = () => new Promise(resolve => { complete = resolve; });
  display.refresh(true); await until(() => Boolean(complete));
  await display.stop();
  assert.deepEqual(f.metadata.get('wHome'), {});
  const before = f.calls.length;
  complete(usage(1_800_000_000_000)); await display.pending;
  assert.equal(f.calls.length, before);
});

test('failed setup and stopped-during-setup do not leak locks or publish late tokens', async t => {
  const f = await fixture(t);
  let warnings = 0;
  const failed = f.start({ onWarning: () => warnings++, run: async () => { throw new Error('secret path'); } });
  await failed.ready; await failed.stop();
  assert.equal(warnings, 1);
  assert.equal(f.fetches.length, 0);
  let resolvePane;
  const slow = f.start({ run: async (args, env) => args[0] === 'pane' ? new Promise(resolve => { resolvePane = resolve; }) : f.options.run(args, env) });
  await until(() => Boolean(resolvePane));
  const stopping = slow.stop();
  resolvePane(JSON.stringify({ result: { pane: { workspace_id: 'wHome' } } }));
  await stopping;
  assert.equal(f.metadata.size, 0);
  assert.equal(f.fetches.length, 0);
});

test('abnormal termination leaves only expiring metadata; no persistent daemon is needed', async t => {
  const f = await fixture(t), display = f.start();
  await until(() => f.metadata.get('wHome')?.opm_cx?.value.includes('62%'));
  clearInterval(display.timer);
  f.advance(45_001);
  const visible = Object.values(f.metadata.get('wHome')).filter(token => token.expires > f.options.now());
  assert.deepEqual(visible, []);
  assert.equal(f.calls.filter(args => args[0] === 'workspace').every(args => args[1] === 'report-metadata'), true);
});

test('resource updates batch <=16 patches and hot reload stops collectors and clears tokens', async t => {
  const f = await fixture(t);
  let settings = { ...SIDEBAR_DEFAULTS }, ramCalls = 0, gpuCalls = 0;
  const metrics = new SystemMetrics({ now: f.options.now,
    disk: async path => ({ path, status: 'ok', device: 1, used: 80, total: 100, percent: 80 }),
    ram: async () => { ramCalls++; return { status: 'ok', used: 9, total: 10, percent: 90 }; },
    gpu: async () => { gpuCalls++; return { status: 'ok', gpus: Array.from({ length: 8 }, (_, index) => ({ uuid: `GPU-${index}`, index, status: 'ok', used: 1, total: 10, percent: 10 })) }; },
  });
  const display = f.start({ metrics, settingsStore: { load: async () => settings } });
  await until(() => Object.values(f.metadata.get('wHome') || {}).some(token => token.value.startsWith('GPU7')));
  const reports = f.calls.filter(args => args[1] === 'report-metadata');
  assert.ok(reports.length > 1);
  for (const args of reports) assert.ok(args.filter(arg => ['--token', '--clear-token'].includes(arg)).length <= 16);
  assert.equal(f.metadata.get('wHome').opm_metric_ram_critical.value, '▰▰▰▰');
  const reloads = f.calls.filter(args => args[0] === 'server').length;
  f.advance(2000); await display.tick(); await until(() => gpuCalls === 2 && !metrics.pending.gpu);
  assert.equal(f.fetches.length, 1); assert.equal(f.calls.filter(args => args[0] === 'server').length, reloads);
  settings = { ...settings, codex: false, claude: false, disk: false, ram: false, gpu: false };
  await display.tick(); assert.deepEqual(f.metadata.get('wHome'), {});
  const counts = [ramCalls, gpuCalls, f.fetches.length];
  f.advance(60000); await display.tick(); assert.deepEqual([ramCalls, gpuCalls, f.fetches.length], counts);
  await display.stop(); assert.deepEqual(f.metadata.get('wHome'), {});
});

test('slow OAuth never blocks resources; malformed settings retain last valid selection', async t => {
  const f = await fixture(t);
  let complete, malformed = false, warnings = 0;
  const display = f.start({ onWarning: () => warnings++, collector: { collect: () => new Promise(resolve => { complete = resolve; }) },
    settingsStore: { load: async () => { if (malformed) throw 0; return { ...SIDEBAR_DEFAULTS, disk: false, gpu: false }; } },
    metrics: new SystemMetrics({ ram: async () => ({ status: 'ok', used: 1, total: 2, percent: 50 }) }),
  });
  await until(() => f.metadata.get('wHome')?.opm_metric_ram_normal?.value === '▰▰▱▱');
  assert.ok(complete); malformed = true; await display.tick();
  assert.equal(warnings, 1); assert.ok(f.metadata.get('wHome').opm_metric_ram_label);
  await display.stop(); const calls = f.calls.length; complete(usage(f.options.now())); await display.pending;
  assert.equal(f.calls.length, calls);
});

test('reporters with different GPU discovery states retain shared registered rows', async t => {
  const f = await fixture(t);
  const first = f.start({ settingsStore: { load: async () => ({ ...SIDEBAR_DEFAULTS, disk: false, ram: false }) },
    metrics: new SystemMetrics({ gpu: async () => ({ status: 'ok', gpus: [{ uuid: 'GPU-one', index: 0, status: 'error' }] }) }),
  });
  await until(() => Object.values(f.metadata.get('wHome') || {}).some(token => token.value.startsWith('GPU0')));
  const other = f.start({ run: async (args, env) => args[0] === 'pane'
    ? JSON.stringify({ result: { pane: { workspace_id: 'wOther' } } }) : f.options.run(args, env) });
  await until(() => f.metadata.get('wOther')?.opm_cx?.value.includes('62%'));
  const reloads = f.calls.filter(args => args[0] === 'server').length;
  for (let i = 0; i < 3; i++) { await first.tick(); await other.tick(); }
  assert.equal(f.calls.filter(args => args[0] === 'server').length, reloads);
  const config = TOML.parse(await readFile(f.env.HERDR_CONFIG_PATH, 'utf8'));
  assert.ok(config.ui.sidebar.spaces.rows.some(row => row[0]?.token?.startsWith('$opm_metric_gpu_')));
});

test('installed Herdr validates generated config without touching the live configuration', {
  skip: !process.env.OPM_HERDR_TEST,
}, async t => {
  const home = await directory(t), path = join(home, 'config.toml');
  await writeFile(path, addQuotaRows('[keys]\nprefix="f1"\n'));
  const result = execFileSync(process.env.OPM_HERDR_TEST, ['config', 'check'], {
    env: { ...process.env, HERDR_CONFIG_PATH: path }, encoding: 'utf8', timeout: 5000,
  });
  assert.match(result, /config: ok/);
});
