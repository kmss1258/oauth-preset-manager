import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import { buildSidebarView, formatGoQuota } from '../src/sidebar-view.js';
import { normalizeSidebarSettings } from '../src/sidebar-settings.js';
import { registeredSidebarRows, setSidebarRows } from '../src/herdr-config.js';

const settings = normalizeSidebarSettings({ codex: false, claude: false, disk: false, ram: false, gpu: false });
const usage = (fiveHour, monthly) => ({ daily: { percent_remaining: fiveHour }, monthly_percent: monthly });
const view = (result, overrides = {}) => buildSidebarView({ ...settings, ...overrides }, [], {}, 1, 14, result);
const text = result => {
  const output = view(result);
  const tokens = output.rows[0].map(part => output.tokens[part.token.slice(1)]).filter(Boolean);
  assert.equal(tokens.length, 1, 'Herdr must not insert a separator between multiple visible tokens');
  assert.ok(stringWidth(tokens[0]) <= 22);
  assert.doesNotMatch(tokens[0], /·| {2}|\x1b/);
  return tokens[0];
};

test('Go 5h and monthly use one compact bar-first row, including 0 and 100 percent', () => {
  assert.equal(text(usage(100, 29)), 'Go 5h▰▰100% M▰▱29%');
  assert.equal(text(usage(100, 100)), 'Go 5h▰▰100% M▰▰100%');
  assert.equal(text(usage(0, 0)), 'Go 5h▱▱0% M▱▱0%');
  assert.equal(text(usage(150, -20)), 'Go 5h▰▰100% M▱▱0%');
  assert.equal(text(usage(75, 50)), 'Go 5h▰▰75% M▰▱50%');
});

test('Go loading, absence, partial windows and failures never invent quota or leak error text', () => {
  assert.equal(text(undefined), 'Go …');
  assert.equal(text(null), 'Go N/A');
  assert.equal(text({ error: 'private upstream token', account_id: 'private account', ...usage(100, 100) }), 'Go error');
  assert.equal(text(usage(null, 29)), 'Go 5hN/A M▰▱29%');
  assert.equal(text(usage(100, undefined)), 'Go 5h▰▰100% MN/A');
  for (const value of [null, undefined, '100', '', NaN, Infinity]) {
    assert.equal(text(usage(value, value)), 'Go N/A');
    assert.equal(formatGoQuota(usage(value, value)).percent, null);
  }
});

test('Go warning uses worst valid window and respects warning toggle', () => {
  for (const [fiveHour, monthly, tone] of [[100, 29, 'label'], [100, 20, 'warning'], [20, 100, 'warning'],
    [100, 10, 'critical'], [10, 100, 'critical'], [null, 10, 'critical'], [100, null, 'label']]) {
    assert.ok(view(usage(fiveHour, monthly)).tokens[`opm_metric_go_${tone}`]);
  }
  const disabled = view(usage(0, 0), { warnings: false });
  assert.ok(disabled.tokens.opm_metric_go_label);
  assert.equal(disabled.tokens.opm_metric_go_critical, '');
  assert.deepEqual(view(usage(100, 29), { go: false }).rows, []);
  assert.deepEqual(view(usage(100, 29), { go: false }).tokens, {});
});

test('adding Go to an already registered layout places it after CC without reload churn', () => {
  const config = normalizeSidebarSettings({ go: false, gpu: false });
  const metrics = { disks: [], ram: null, gpus: [] };
  const old = buildSidebarView(config, [], metrics).rows;
  const source = setSidebarRows('', old);
  const next = buildSidebarView({ ...config, go: true }, [], metrics).rows;
  const registered = registeredSidebarRows(source, next);
  assert.deepEqual(registered.slice(0, 4).map(row => row[0].token),
    ['$opm_metric_cx_label', '$opm_metric_cc_label', '$opm_metric_go_label', '$opm_metric_disk_0_label']);
  assert.deepEqual(registeredSidebarRows(setSidebarRows(source, registered), old), registered);
});

test('Go follows CC, inherits old settings defaults, and participates in row budget', () => {
  assert.equal(normalizeSidebarSettings({ version: 1, codex: false }).go, true);
  assert.equal(normalizeSidebarSettings({ go: false }).go, false);
  assert.throws(() => normalizeSidebarSettings({ go: 'true' }));
  const output = buildSidebarView(normalizeSidebarSettings({ disk: false, ram: false, gpu: false }), [], {}, 1, 14, usage(100, 29));
  assert.deepEqual(output.rows.map(row => row[0].token), ['$opm_metric_cx_label', '$opm_metric_cc_label', '$opm_metric_go_label']);
  const crowded = buildSidebarView(normalizeSidebarSettings({ disk: false, ram: false, gpu: false }), [], {}, 1, 2, usage(100, 29));
  assert.equal(crowded.rows.length, 2);
  assert.ok(crowded.overflow);
  assert.match(crowded.tokens.opm_metric_more_label, /^\+2 items/);
});
