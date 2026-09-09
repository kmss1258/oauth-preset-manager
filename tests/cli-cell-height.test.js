import assert from 'node:assert/strict';
import test from 'node:test';
import chalk from 'chalk';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { buildQuotaFrame, fitQuotaCell } from '../src/cli.js';

const quota = { percent_remaining: 75, reset_time_iso: '2099-09-07T12:00:00Z' };

test('cell clipping enforces two physical lines and marks omitted content', () => {
  for (const width of [1, 8, 16, 36]) {
    const text = fitQuotaCell('\x1b[31m계정👩‍💻'.repeat(20) + '\x1b[0m\nsecond line\nthird line\nsecret tail', width);
    const lines = text.split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines.every(line => stringWidth(line) <= width));
    assert.ok(stripAnsi(lines[1]).endsWith('…'));
    assert.doesNotMatch(stripAnsi(text), /third|secret/);
  }
});

test('every provider table row is at most two lines despite active labels, presets, cache and errors', () => {
  const items = [
    { provider: 'openai', account_id: 'active-account', presets: ['(Current Active)', 'preset-one', 'preset-two'],
      daily: quota, weekly: quota, error: 'long provider error '.repeat(40) },
    { provider: 'claude', account_id: 'cached-account', presets: ['preset-one', 'preset-two'], daily: quota, weekly: quota,
      cached: true, cached_at: new Date().toISOString(), cache_error: 'rate limited '.repeat(10),
      extra_windows: [{ ...quota, label: 'Sonnet' }, { ...quota, label: 'Opus' }] },
    { provider: 'opencodego', account_id: 'Go', presets: ['(Current Active)'], daily: quota, weekly: quota,
      monthly_percent: 29, monthly_reset_iso: '2099-01-01T00:00:00Z' },
    { provider: 'commandcode', account_id: 'command', nickname: 'nickname '.repeat(20), daily: quota,
      command_code_usage: { total_tokens: 123456 }, error: 'certificate error '.repeat(20) },
    { provider: 'google', account_id: 'google-account', daily: { ...quota, label: 'long model '.repeat(20) } },
  ];
  const original = structuredClone(items), oldLevel = chalk.level;
  try {
    for (const level of [0, 3]) {
      chalk.level = level;
      for (const columns of [100, 120, 180, 240]) {
        const lines = buildQuotaFrame(items, { columns, showGoogle: true }).lines.map(stripAnsi);
        const data = lines.filter(line => line.startsWith('│')).slice(1);
        assert.ok(!data.some(line => /^│[ │]+│$/.test(line)), 'No synthetic spacer rows');
        const groups = [];
        for (const line of data) {
          if (line.split('│')[1].trim()) groups.push([]);
          groups.at(-1).push(line);
        }
        assert.equal(groups.length, items.length);
        assert.ok(groups.every(group => group.length <= 2), `${columns}: ${groups.map(group => group.length)}`);
        assert.ok(lines.every(line => stringWidth(line) <= columns - 1));
      }
    }
    assert.deepEqual(items, original);
  } finally { chalk.level = oldLevel; }
});

test('an active-only first account keeps two content lines even in a very wide table', () => {
  const items = [
    { provider: 'openai', account_id: '00000000-1111-2222-3333-444444444444', presets: ['(Current Active)'],
      plan_type: 'pro', plan_type_source: 'usage', daily: quota },
    { provider: 'opencodego', account_id: 'Go', presets: ['(Current Active)'], daily: quota, weekly: quota,
      monthly_percent: 29, monthly_reset_iso: '2099-01-01T00:00:00Z' },
  ];
  const original = structuredClone(items), oldLevel = chalk.level;
  try {
    for (const level of [0, 3]) {
      chalk.level = level;
      for (const columns of [100, 120, 145, 180, 240, 320]) {
        const lines = buildQuotaFrame(items, { columns, rows: 40, interactive: true, output: { isTTY: true } }).lines.map(stripAnsi);
        const data = lines.filter(line => line.startsWith('│')).slice(1);
        assert.equal(data.length, 4, `${columns}: both active accounts must occupy two lines`);
        assert.match(data[0].split('│')[1], /openai/);
        assert.doesNotMatch(data[0], /Current Active/);
        assert.equal(data[1].split('│').at(-2).trim(), '(Current Active)');
        assert.match(data[2].split('│')[1], /opencodego/);
        assert.match(data[3].split('│').at(-2), /M .*29%/);
        assert.ok(!data.some(line => /^│[ │]+│$/.test(line)), 'No synthetic spacer rows');
        assert.ok(lines.every(line => stringWidth(line) <= columns - 1));
      }
    }
    assert.deepEqual(items, original);
  } finally { chalk.level = oldLevel; }
});
