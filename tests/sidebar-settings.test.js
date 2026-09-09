import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import TOML from '@iarna/toml';
import { SidebarSettings, SIDEBAR_DEFAULTS, normalizeSidebarSettings } from '../src/sidebar-settings.js';
import { sidebarSettingsMenu } from '../src/sidebar-menu.js';
import { buildSidebarView, warningLevel } from '../src/sidebar-view.js';
import { setSidebarRows, sidebarRowBudget, addQuotaRows } from '../src/herdr-config.js';
import { interactiveMode } from '../src/cli.js';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'opm-sidebar-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
const metrics = { disks: [], ram: null, gpus: [], gpuStatus: 'missing' };
const defaults = () => normalizeSidebarSettings();

test('settings defaults, private atomic save, unrelated files and malformed/symlink refusal', async t => {
  const path = await directory(t), store = new SidebarSettings(path);
  assert.deepEqual(await store.load(), SIDEBAR_DEFAULTS);
  await writeFile(join(path, 'config.json'), 'preserve');
  await store.save({ ram: false, gpuIds: ['GPU-aaa', 'GPU-aaa'], diskPaths: ['/', '/home/..'] });
  assert.deepEqual((await store.load()).gpuIds, ['GPU-aaa']);
  assert.deepEqual((await store.load()).diskPaths, ['/']);
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.equal(await readFile(join(path, 'config.json'), 'utf8'), 'preserve');
  await writeFile(store.path, '{bad');
  await assert.rejects(store.load()); await assert.rejects(store.save(defaults()));
  assert.equal(await readFile(store.path, 'utf8'), '{bad');
  await rm(store.path); await symlink(join(path, 'config.json'), store.path);
  await assert.rejects(store.load()); await assert.rejects(store.save(defaults()));
});

test('settings reject invalid versions, types, paths and refresh rates', () => {
  for (const value of [null, [], { version: 2 }, { ram: 1 }, { diskPaths: ['relative'] }, { diskPaths: ['/\nsecret'] },
    { gpuIds: ['index:0'] }, { gpuInterval: 1 }, { gpuInterval: '2' }, { unknown: true }]) assert.throws(() => normalizeSidebarSettings(value));
  assert.equal(normalizeSidebarSettings({ gpuInterval: 10 }).gpuInterval, 10);
});

test('settings menu saves selected fields, disk paths, UUID and interval; cancel writes nothing', async t => {
  const path = await directory(t), store = new SidebarSettings(path);
  const actions = ['items', 'disks', 'gpus', 'pick', 'interval', 5, 'save'];
  const selections = [['go', 'disk', 'ram', 'gpu', 'warnings'], ['/'], ['GPU-bbb']];
  await sidebarSettingsMenu(path, { select: async () => actions.shift(), checkbox: async () => selections.shift(), input: async () => '/data' },
    { gpuUsage: async () => ({ status: 'ok', gpus: [{ index: 1, uuid: 'GPU-bbb', name: 'RTX', total: 8 * 1024 ** 3 }] }) });
  const saved = await store.load();
  assert.equal(saved.codex, false); assert.equal(saved.claude, false); assert.equal(saved.go, true); assert.equal(saved.ram, true);
  assert.deepEqual(saved.diskPaths, ['/', '/data']); assert.deepEqual(saved.gpuIds, ['GPU-bbb']); assert.equal(saved.gpuInterval, 5);
  const before = await readFile(store.path);
  const cancel = ['items', 'cancel'];
  await sidebarSettingsMenu(path, { select: async () => cancel.shift(), checkbox: async () => [] });
  assert.deepEqual(await readFile(store.path), before);
});

test('interactive opm exposes sidebar settings without auth or presets', async t => {
  const path = await directory(t), selections = ['__sidebar__', 'cancel', '__exit__'];
  const manager = { configDir: path, config: {}, getAuthPath: () => join(path, 'missing-auth.json'),
    listPresets: async () => [], detectCurrentPreset: async () => null };
  await interactiveMode(manager, { select: async ({ choices }) => {
    const selection = selections.shift(); assert.ok(choices.some(choice => choice.value === selection)); return selection;
  }, input: async () => '', confirm: () => assert.fail('must not require auth setup') });
  assert.equal(selections.length, 0);
});

test('warning boundaries and single-token rows preserve bar-first order without bullets', () => {
  for (const [used, level] of [[79.9, 'normal'], [80, 'warning'], [89.9, 'warning'], [90, 'critical'], [100, 'critical']]) {
    assert.equal(warningLevel(used), level); assert.equal(warningLevel(100 - used, true), level);
    assert.equal(warningLevel(used, false, false), 'normal');
  }
  const view = buildSidebarView(defaults(), [{ provider: 'codex', percent: 10, status: 'ok', resetAt: 1234 }], {
    ...metrics, disks: [{ path: '/', status: 'ok', used: 850 * 1024 ** 3, total: 930 * 1024 ** 3, percent: 91.4 }],
    ram: { status: 'ok', used: 24 * 1024 ** 3, total: 64 * 1024 ** 3, percent: 37.5 },
    gpus: [{ uuid: 'GPU-aaa', index: 0, status: 'ok', used: 6 * 1024 ** 3, total: 16 * 1024 ** 3, percent: 37.5 }],
  });
  assert.equal(view.tokens.opm_metric_disk_0_label, '');
  assert.equal(view.tokens.opm_metric_disk_0_critical, 'Disk / ▰▰▰▰ 850/930G');
  assert.equal(view.tokens.opm_metric_disk_0_warning, '');
  assert.equal(view.tokens.opm_metric_cx_critical, 'CX ▱▱▱▱ 10% reset');
  assert.equal(view.rows[0][0].fg, '#10A37F');
  assert.ok(Object.values(view.tokens).includes('GPU0 ▰▰▱▱ 6/16G'));
  for (const row of view.rows) {
    const visible = row.map(part => view.tokens[part.token.slice(1)]).filter(Boolean);
    assert.equal(visible.length, 1);
    assert.ok(!visible[0].includes('·'));
    assert.ok(!visible[0].includes('  '));
  }
  assert.ok(Object.keys(view.tokens).every(key => key.length <= 32));
  assert.ok(Object.values(view.tokens).every(value => value.length <= 80 && !value.includes('\x1b')));
});

test('row overflow is explicit and old owned rows migrate without touching user rows/comments', () => {
  const view = buildSidebarView(defaults(), [], { ...metrics,
    gpus: Array.from({ length: 30 }, (_, index) => ({ uuid: `GPU-${index}`, index, status: 'error' })) });
  assert.equal(view.rows.length, 14); assert.ok(view.overflow > 0);
  assert.match(view.tokens.opm_metric_more_label, /GPUs/);
  const rows = view.rows.slice(0, 2);
  const originals = ['', '[ui.sidebar.spaces]\nrows=[]\n', '[ui.sidebar.spaces]\nrows=[["workspace"]]\n',
    addQuotaRows('# keep theme\n[theme]\nname="gruvbox"\n'),
    '[ui.sidebar.spaces]\nrows=[["workspace"], # keep comment\n[{token="$opm_cx",fg="#10A37F"}],[{token="$opm_cc",fg="#D87555"}]]\n',
    '[ui.sidebar.spaces]\nrows=[[{token="$opm_cx",fg="#fff"}]]\n'];
  for (const original of originals) {
    const output = setSidebarRows(original, rows);
    assert.equal(setSidebarRows(output, rows), output);
    const cleared = setSidebarRows(output, []);
    assert.ok(!cleared.includes('$opm_metric_'));
    if (original.includes('# keep comment')) assert.ok(cleared.includes('# keep comment'));
    if (original.includes('#fff')) assert.ok(cleared.includes('#fff'));
    assert.ok(TOML.parse(cleared).ui.sidebar.spaces.rows.length <= 2);
  }
  const full = '[ui.sidebar.spaces]\n' + TOML.stringify({ rows: Array.from({ length: 16 }, () => ['workspace']) });
  assert.equal(sidebarRowBudget(full), 0); assert.throws(() => setSidebarRows(full, rows));
});
