import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import chalk from 'chalk';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { buildQuotaFrame, cmdQuota, fitQuotaLine, formatQuotaCountdownLine, normalizeQuotaResults } from '../src/cli.js';
import { setLanguage } from '../src/i18n.js';

const quota = { percent_remaining: 75, reset_time_iso: '2099-09-07T12:00:00Z' };
const results = [
  { provider: 'openai', account_id: 'first-account', nickname: '한국어 👩‍💻 계정'.repeat(8), presets: ['개인 프리셋'], daily: quota, weekly: quota },
  { provider: 'claude', account_id: 'claude-test', daily: quota, weekly: quota, extra_windows: [{ ...quota, label: 'Sonnet' }] },
  { provider: 'opencodego', account_id: 'wrk_test', daily: quota, weekly: quota, monthly_percent: 50 },
  { provider: 'commandcode', account_id: 'command-test', daily: quota, weekly: quota, command_code_credits: { total_remaining: 13 }, command_code_usage: { total_cost: 12.34, total_count: 42 } },
  { provider: 'google', account_id: 'google-test', daily: { ...quota, label: 'G3Pro' } },
];

test('quota frame fits both axes across languages, colors and tiny terminals', () => {
  const oldLevel = chalk.level;
  try {
    for (const language of ['ko', 'en']) {
      setLanguage(language);
      for (const color of [0, 3]) {
        chalk.level = color;
        for (const columns of [1, 2, 8, 16, 20, 32, 39, 60, 79, 80, 99, 100, 120, 180]) {
          for (const rows of [1, 2, 4, 5, 10, 24, 60]) {
            const frame = buildQuotaFrame(results, { columns, rows, interactive: true, seconds: 60, showGoogle: true, rootDiskLine: '💾 / 10.0 GiB' });
            assert.ok(frame.lines.length <= rows - 1, `${columns}x${rows}: height`);
            for (const line of frame.lines) {
              assert.ok(stringWidth(line) <= columns - 1, `${columns}x${rows}: ${stripAnsi(line)}`);
              assert.ok(!line.includes('\n') && !line.includes('\r'));
            }
          }
        }
      }
    }
  } finally { chalk.level = oldLevel; setLanguage('en'); }
});

test('narrow quota keeps bars, percentages, weekly/monthly/scoped windows and details', () => {
  for (const columns of [20, 32, 60, 79, 99, 100, 120]) {
    const text = stripAnsi(buildQuotaFrame(results, { columns, showGoogle: true }).lines.join('\n'));
    assert.match(text, /[█░]+\s+75%/);
    assert.match(text, /[█░]+\s+50%/);
    assert.match(text, /Sonnet/);
    assert.doesNotMatch(text, /13\.00 credits|12\.34 used/);
    assert.match(text, /42 requests/);
  }
});

test('account display selects two newest metadata dates without mutating or merging source rows', () => {
  const presetMetadata = {
    old: { last_used: '2026-01-01', created_at: '2026-12-01' },
    newest: { last_used: '2026-09-08', created_at: '2025-01-01' },
    recent: { last_used: 'invalid', created_at: '2026-09-07' },
    invalid: { last_used: 'invalid', created_at: 'Never' },
  };
  const items = ['old', 'invalid'].map(name => ({ provider: 'openai', account_id: 'real-account', nickname: name,
    presets: [name, 'recent (~/presets/recent.json)', 'newest', 'missing'], daily: quota }));
  const original = structuredClone(items);
  for (const columns of [60, 120, 180]) {
    const text = stripAnsi(buildQuotaFrame(items, { columns, presetMetadata }).lines.join('\n'));
    assert.equal((text.match(/real-account/g) || []).length, 2);
    assert.equal((text.match(/newest/g) || []).length, 2);
    assert.equal((text.match(/recent/g) || []).length >= 2, true);
    assert.ok(text.indexOf('newest') < text.indexOf('recent'));
    assert.doesNotMatch(text, /old|invalid|missing/);
  }
  assert.deepEqual(items, original);
  assert.equal(normalizeQuotaResults(items).length, 2);
  assert.deepEqual(normalizeQuotaResults(items).map(item => item.presets.length), [4, 4]);
});

test('unknown dates retain source order and active identity survives the display limit', () => {
  const item = { provider: 'openai', account_id: 'real-account',
    presets: ['first (~/2099-01-01.json)', '(Current Active)', 'second', 'third'], daily: quota };
  for (const columns of [60, 180]) {
    const text = stripAnsi(buildQuotaFrame([item], { columns, presetMetadata: {
      first: { last_used: 'invalid' }, second: { created_at: 'Never' },
    } }).lines.join('\n'));
    assert.match(text, /real-account \(Current Active\)/);
    assert.ok(text.indexOf('first') < text.indexOf('second'));
    assert.doesNotMatch(text, /third/);
    const dated = stripAnsi(buildQuotaFrame([item], { columns, presetMetadata: {
      second: { created_at: '2026-01-01' }, third: { last_used: '2026-02-01' },
    } }).lines.join('\n'));
    assert.ok(dated.indexOf('third') < dated.indexOf('second'));
    assert.doesNotMatch(dated, /first|2099/);
  }
});

test('Command Code account is at most two physical lines even with verbose sources and a long nickname', () => {
  const item = { provider: 'commandcode', account_id: 'org-test', nickname: 'Long account name '.repeat(10) + '\nextra nickname line',
    presets: ['source-one', 'source-two', 'source-three'], daily: quota, weekly: quota,
    command_code_usage: { total_tokens: 123456, total_count: 42, total_cost: 12.34 },
    command_code_credits: { total_remaining: 13 }, extra_windows: [{ ...quota, label: 'extra' }] };
  const original = structuredClone(item);
  for (const columns of [20, 39, 99, 100, 120, 180]) {
    const lines = buildQuotaFrame([item], { columns }).lines.map(stripAnsi);
    assert.ok(lines.every(line => stringWidth(line) <= columns - 1));
    assert.doesNotMatch(lines.join('\n'), /source-|credits|requests|used|extra nickname/);
    if (columns >= 100) {
      const cells = lines.filter(line => line.startsWith('│')).slice(1).map(line => line.split('│').at(-2).trim()).filter(Boolean);
      assert.equal(cells.length, 2);
      assert.match(cells[1], /123,456 tokens/);
    } else {
      const start = lines.findIndex(line => line.includes('● Command Code'));
      assert.match(lines[start + 2], /123,456 tokens/);
      assert.match(lines[start + 3], /^D /);
    }
  }
  assert.deepEqual(item, original);
});

test('paging exposes all body lines without scrolling and clamps after resize', () => {
  const options = { columns: 39, rows: 10, interactive: true, showGoogle: true };
  const first = buildQuotaFrame(results, options);
  assert.ok(first.pages > 1);
  const pages = Array.from({ length: first.pages }, (_, page) => buildQuotaFrame(results, { ...options, page }));
  const text = pages.flatMap(frame => frame.lines.slice(2, -1)).join('\n');
  assert.match(text, /first-account|한국어/);
  assert.match(text, /claude-test/);
  assert.match(text, /google-test/);
  assert.match(text, /Sonnet/);
  assert.equal(buildQuotaFrame([], { ...options, page: 500 }).page, 0);
  assert.equal(buildQuotaFrame(results, { ...options, page: -10 }).page, 0);
  assert.match(first.lines.at(-1), /j\/k/);
});

test('mobile pages keep short account groups and boundary percentages intact', () => {
  const items = ['one', 'two'].map(account_id => ({ provider: 'claude', account_id,
    daily: { percent_remaining: 100 }, weekly: { percent_remaining: 0 } }));
  for (const columns of [20, 32, 39]) {
    const options = { columns, rows: 10, interactive: true };
    const first = buildQuotaFrame(items, options);
    assert.equal(first.pages, 2);
    for (let page = 0; page < first.pages; page++) {
      const text = stripAnsi(buildQuotaFrame(items, { ...options, page }).lines.join('\n'));
      assert.match(text, /● Claude/);
      assert.match(text, /█+\s+100%/);
      assert.match(text, /░+\s+0%/);
    }
  }
});

test('countdown prioritizes refresh at narrow widths and never wraps', () => {
  for (const language of ['ko', 'en']) {
    setLanguage(language);
    for (const width of [8, 16, 20, 39, 79, 120]) {
      const line = formatQuotaCountdownLine(59, new Date('2026-09-07T01:00:00Z'), undefined, { width });
      assert.ok(stringWidth(line) <= width);
      assert.match(stripAnsi(line), /59/);
    }
  }
  setLanguage('en');
});

test('width clipping preserves graphemes and strips untrusted terminal control sequences', () => {
  assert.equal(fitQuotaLine('한글👩‍💻text', 7), '한글👩‍💻…');
  assert.equal(fitQuotaLine('\x1b[31mhello\x1b[0m', 10), '\x1b[31mhello\x1b[0m');
  const hostile = '\x1b[2Jhello\x1b]0;owned\x07\r\n\tworld';
  const safe = fitQuotaLine(hostile, 80);
  assert.ok(!safe.includes('\x1b'));
  assert.ok(!safe.includes('\r') && !safe.includes('\n'));
  assert.equal(fitQuotaLine('hello', 0), '');
});

test('actual opm q without credentials exits cleanly when piped', async t => {
  const home = await mkdtemp(join(tmpdir(), 'opm-quota-empty-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const text = execFileSync(process.execPath, ['src/cli.js', 'q'], {
    env: { PATH: process.env.PATH, HOME: home, OPM_LANG: 'en' }, encoding: 'utf8', timeout: 10000,
  });
  assert.match(text, /No quota data available/);
  assert.ok(!text.includes('\x1b'));
  assert.ok(!text.includes('Refresh in'));
});

test('interactive loop handles ticks, resizing, paging, Google toggle, refresh and exit', async () => {
  const descriptors = { stdin: Object.getOwnPropertyDescriptor(process, 'stdin'), stdout: Object.getOwnPropertyDescriptor(process, 'stdout') };
  const stdin = new EventEmitter();
  Object.assign(stdin, { isTTY: true, isRaw: false, paused: true,
    setRawMode(value) { this.isRaw = value; }, isPaused() { return this.paused; },
    pause() { this.paused = true; }, resume() { this.paused = false; } });
  const stdout = new EventEmitter();
  const writes = [];
  Object.assign(stdout, { isTTY: true, columns: 120, rows: 24, write(text) { writes.push(text); return true; } });
  let fetches = 0;
  let failRefresh = false;
  const manager = { async collectAllQuota() { fetches++; if (failRefresh) throw new Error('temporary failure'); return results; }, async cacheQuotaResults() {} };
  const waitFor = async predicate => {
    for (let i = 0; i < 300; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('quota loop did not reach expected state');
  };
  let running;
  try {
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
    running = cmdQuota(manager);
    await waitFor(() => writes.some(text => text.startsWith('\x1b[2;1H')));
    assert.ok(writes.filter(text => text.startsWith('\x1b[2;1H')).every(text => !text.includes('\n')));
    for (const [columns, rows] of [[32, 10], [8, 3], [79, 24], [120, 40]]) {
      const previous = writes.length;
      stdout.columns = columns; stdout.rows = rows;
      stdout.emit('resize');
      await waitFor(() => writes.length > previous && stdin.listenerCount('data') === 1);
      assert.ok(writes.at(-1).startsWith('\x1b[H\x1b[2J'));
      assert.equal(fetches, 1, 'resize must not fetch');
    }
    for (const key of ['j', 'k', 'g', 'ㄱ']) {
      const previous = writes.length;
      stdin.emit('data', Buffer.from(key));
      await waitFor(() => writes.length > previous && stdin.listenerCount('data') === 1);
    }
    assert.equal(fetches, 2);
    failRefresh = true;
    stdin.emit('data', Buffer.from('r'));
    await waitFor(() => writes.at(-1).includes('Refresh failed') && stdin.listenerCount('data') === 1);
    assert.match(writes.at(-1), /OpenAI|openai/);
    assert.equal(fetches, 3);
    stdin.emit('data', Buffer.from('\x03'));
    await running;
    assert.equal(writes.at(-1), '\x1b[?25h\x1b[?1049l');
    assert.equal(stdin.listenerCount('data'), 0);
    assert.equal(stdout.listenerCount('resize'), 0);
    assert.equal(stdin.isRaw, false);
    assert.equal(stdin.paused, true);
    const failed = cmdQuota({ collectAllQuota: async () => { throw new Error('synthetic failure'); } });
    await assert.rejects(failed, /synthetic failure/);
    assert.equal(writes.at(-1), '\x1b[?25h\x1b[?1049l');
    assert.equal(stdin.listenerCount('data'), 0);
    assert.equal(stdout.listenerCount('resize'), 0);
  } finally {
    stdin.emit('data', Buffer.from('q'));
    if (running) await running;
    for (const [name, descriptor] of Object.entries(descriptors)) Object.defineProperty(process, name, descriptor);
  }
});
