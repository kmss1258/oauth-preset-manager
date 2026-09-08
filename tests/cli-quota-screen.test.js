import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import chalk from 'chalk';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { buildQuotaFrame, cmdQuota, fitQuotaLine, formatQuotaCountdownLine, normalizeQuotaResults, writeQuotaFrame } from '../src/cli.js';
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

test('only the first normalized account is highlighted without changing layout or source data', () => {
  const oldLevel = chalk.level;
  const oldNoColor = process.env.NO_COLOR;
  const items = [
    { provider: 'claude', account_id: 'other-account', daily: quota, weekly: quota },
    { provider: 'openai', account_id: 'top-account', presets: ['(Current Active)'], daily: quota, weekly: quota },
  ];
  const original = structuredClone(items);
  try {
    chalk.level = 3;
    delete process.env.NO_COLOR;
    for (const columns of [39, 99, 100, 120, 160]) {
      const options = { columns, rows: 40, interactive: true, output: { isTTY: true }, now: new Date('2026-09-06T12:00:00Z') };
      const frame = buildQuotaFrame(items, options);
      const plain = buildQuotaFrame(items, { ...options, output: { isTTY: false } });
      assert.deepEqual(frame.lines.map(stripAnsi), plain.lines.map(stripAnsi));
      assert.ok(frame.lines.every(line => stringWidth(line) <= columns - 1));
      const highlighted = frame.lines.filter(line => line.includes('\x1b[100m'));
      assert.ok(highlighted.some(line => line.includes('top-account')));
      assert.ok(highlighted.some(line => /openai|OpenAI/.test(line)));
      assert.ok(highlighted.every(line => !line.includes('other-account') && !line.includes('claude') && !line.includes('Claude')));
      assert.ok(!plain.lines.join('\n').includes('\x1b[100m'));
      assert.ok(!buildQuotaFrame(items, { ...options, interactive: false }).lines.join('\n').includes('\x1b[100m'));
      process.env.NO_COLOR = '1';
      assert.ok(!buildQuotaFrame(items, options).lines.join('\n').includes('\x1b[100m'));
      delete process.env.NO_COLOR;
    }
    const options = { columns: 39, rows: 10, interactive: true, output: { isTTY: true } };
    const first = buildQuotaFrame(items, options);
    assert.ok(first.pages > 1);
    assert.ok(first.lines.join('\n').includes('\x1b[100m'));
    for (let page = 1; page < first.pages; page++) {
      assert.ok(!buildQuotaFrame(items, { ...options, page }).lines.join('\n').includes('\x1b[100m'));
    }
    chalk.level = 0;
    assert.ok(!buildQuotaFrame(items, options).lines.join('\n').includes('\x1b[100m'));
    assert.deepEqual(items, original);
  } finally {
    chalk.level = oldLevel;
    if (oldNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = oldNoColor;
  }
});

test('quota separates the active group once in wide tables without adding compact gaps', () => {
  const active = [
    { provider: 'openai', account_id: 'active-one', presets: ['(Current Active)'], daily: quota },
    { provider: 'claude', account_id: 'active-two', presets: ['(Current Active)'], daily: quota },
  ];
  const saved = ['saved-one', 'saved-two'].map(account_id => ({ provider: 'openai', account_id, daily: quota }));
  for (const columns of [39, 99, 100, 120, 180]) {
    for (const current of [[], active.slice(0, 1), active]) {
      for (const remaining of [[], saved]) {
        if (!current.length && !remaining.length) continue;
        const items = [...remaining, ...current];
        const lines = buildQuotaFrame(items, { columns }).lines.map(stripAnsi);
        if (columns >= 100) {
          const blankRows = lines.flatMap((line, index) => /^│[ │]+│$/.test(line) ? [index] : []);
          assert.equal(blankRows.length, current.length && remaining.length ? 1 : 0);
          if (blankRows.length) {
            const boundary = blankRows[0];
            const activeLines = buildQuotaFrame(current, { columns }).lines.map(stripAnsi);
            assert.deepEqual(lines.slice(2, boundary), activeLines.slice(2, -1));
            assert.ok(lines[boundary + 1].includes('saved-one'));
            assert.equal(lines[boundary].split('│').length, 8);
          }
        } else {
          assert.equal(lines.filter(line => line === '').length, items.length - 1);
          assert.ok(lines.at(-1));
          for (let index = 1; index < lines.length; index++) {
            if (lines[index].startsWith('●') && index > 2) {
              assert.equal(lines[index - 1], '');
              assert.notEqual(lines[index - 2], '');
            }
          }
        }
        for (const rows of [5, 10, 24]) {
          const options = { columns, rows, interactive: true };
          const first = buildQuotaFrame(items, options);
          const pages = Array.from({ length: first.pages }, (_, page) => buildQuotaFrame(items, { ...options, page }));
          assert.ok(pages.every(frame => frame.lines.length <= rows - 1 && frame.lines.every(line => stringWidth(line) <= columns - 1)));
          const pagedBody = pages.flatMap(frame => frame.lines.slice(2, -1)).map(stripAnsi).filter(Boolean);
          assert.deepEqual(pagedBody, lines.slice(2).filter(Boolean));
        }
      }
    }
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

test('countdown digit transitions keep a stable layout at every width including emoji boundaries', () => {
  try {
    for (const language of ['en', 'ko']) {
      setLanguage(language);
      for (const now of [new Date('2026-09-07T01:00:00Z'), new Date('2026-09-07T14:00:00Z')]) {
        for (let width = 8; width <= 160; width++) {
          const lines = [60, 59, 10, 9, 1, 60].map(seconds => stripAnsi(formatQuotaCountdownLine(seconds, now, undefined, { width })));
          const shape = line => line.replace(/[\d ]/g, '#');
          assert.ok(lines.every(line => stringWidth(line) === stringWidth(lines[0])), `${language}/${width}: ${lines}`);
          assert.ok(lines.every(line => shape(line) === shape(lines[0])), `${language}/${width}: ${lines}`);
        }
      }
    }
  } finally { setLanguage('en'); }
});

test('Go monthly percentage and reset use one line when possible and two at the table boundary', () => {
  const item = { provider: 'opencodego', account_id: 'wrk_test', daily: quota, weekly: quota,
    monthly_percent: 64, monthly_reset_iso: new Date(Date.now() + (720 * 60 + 59) * 60000 + 30000).toISOString() };
  for (const columns of [39, 99, 100, 120, 160]) {
    const lines = buildQuotaFrame([item], { columns }).lines.map(stripAnsi);
    const cells = columns >= 100 ? lines.filter(line => line.startsWith('│')).slice(1).map(line => line.split('│').at(-2).trim()).filter(Boolean) : lines;
    const monthly = cells.findIndex(line => /^M\s/.test(line));
    assert.ok(monthly >= 0, `${columns}: ${cells}`);
    assert.match(cells[monthly], /64%/);
    assert.match(cells.slice(monthly).join('\n'), /720h 59m/);
    if (columns === 100) assert.equal(cells.length - monthly, 2);
    else assert.match(cells[monthly], /64% · 720h 59m/);
  }
});

test('frame writes address physical rows with wrapping disabled and restore it immediately', () => {
  const writes = [];
  writeQuotaFrame({ lines: ['emoji 👩‍💻'.repeat(10), 'status', 'body'] }, { write: text => writes.push(text) });
  assert.equal(writes.length, 1);
  assert.ok(writes[0].startsWith('\x1b[H\x1b[2J\x1b[?7l\x1b[1;1H'));
  assert.ok(writes[0].includes('\x1b[2;1Hstatus\x1b[3;1Hbody'));
  assert.ok(writes[0].endsWith('\x1b[?7h'));
});

test('isolated tmux preserves physical rows through ticks, emoji overflow, resize and exit', {
  skip: !process.env.OPM_TMUX_TEST, timeout: 120000,
}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'opm-pty-'));
  const socket = join(home, 'socket');
  const tmux = (...args) => execFileSync(process.env.OPM_TMUX_TEST, ['-S', socket, ...args], { encoding: 'utf8' });
  t.after(async () => {
    try { tmux('kill-server'); } catch {}
    await rm(home, { recursive: true, force: true });
  });
  const fixture = join(home, 'fixture.mjs');
  await writeFile(fixture, `
    import { cmdQuota, buildQuotaFrame, writeQuotaFrame, updateQuotaCountdownLine } from ${JSON.stringify(new URL('../src/cli.js', import.meta.url).href)};
    const results = [{ provider: 'opencodego', account_id: 'wrk_pty', monthly_percent: 64,
      monthly_reset_iso: new Date(Date.now() + 30 * 86400000).toISOString() }];
    globalThis.fetch = () => { throw new Error('network forbidden'); };
    process.stdout.write('BEFORE_QUOTA\\r\\n');
    await cmdQuota({ collectAllQuota: async () => results, cacheQuotaResults: async () => {} });
    process.stdout.write('RESTORED\\r\\n');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let seconds = 60;
    const now = new Date('2026-09-07T01:00:00Z');
    const draw = () => writeQuotaFrame(buildQuotaFrame(results, {
      columns: process.stdout.columns, rows: process.stdout.rows, interactive: true,
      seconds, now, output: process.stdout, rootDiskLine: '👩‍💻'.repeat(100),
    }));
    process.stdout.on('resize', draw);
    process.stdin.on('data', data => {
      const key = data.toString();
      if (key === 's') { process.stdout.write('\\x1b[?1049h'); draw(); }
      else if (key === 'e') {
        // Deliberately exceed physical width: emulate a terminal/library width disagreement.
        writeQuotaFrame({ lines: ['👩‍💻'.repeat(100), 'status', 'ROW_THREE_SENTINEL'] });
        updateQuotaCountdownLine(seconds, { columns: 300, isTTY: true,
          write: text => process.stdout.write(text) }, now);
      } else {
        seconds = { a: 60, b: 59, c: 10, d: 9, e: 1, f: 60 }[key] ?? 1;
        updateQuotaCountdownLine(seconds, process.stdout, now);
      }
    });
  `);
  tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'quota', '-x', '120', '-y', '24',
    `exec env HOME='${home}' OPM_LANG=en '${process.execPath}' '${fixture}'`);
  const capture = () => tmux('capture-pane', '-p', '-t', 'quota').split(/\r?\n/).map(line => line.trimEnd());
  const waitFor = async predicate => {
    for (let i = 0; i < 150; i++) {
      const lines = capture();
      if (predicate(lines)) return lines;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(capture().join('\n'));
  };
  await waitFor(lines => lines.some(line => line.includes('wrk_pty')));
  for (const width of [39, 99, 100, 120, 160]) {
    tmux('resize-window', '-t', 'quota', '-x', String(width), '-y', '24');
    const lines = await waitFor(lines => lines.some(line => line.includes('64%')) &&
      (width < 100 ? lines[2].includes('● OpenCode Go') : lines[2].startsWith('┌') && lines[2].trimEnd().length === width - 1));
    assert.ok(lines.some(line => /719h|720h/.test(line)));
    t.diagnostic(`cmdQuota PTY resize ${width}: monthly percentage/reset visible`);
  }
  tmux('send-keys', '-t', 'quota', 'q');
  await waitFor(lines => lines.some(line => line.includes('RESTORED')));
  assert.match(capture().join('\n'), /BEFORE_QUOTA/);
  assert.equal(tmux('display-message', '-p', '-t', 'quota', '#{alternate_on}:#{wrap_flag}:#{cursor_flag}').trim(), '0:1:1');
  tmux('send-keys', '-t', 'quota', 's');
  await waitFor(lines => lines.some(line => line.includes('wrk_pty')));
  for (const width of [39, 80, 81, 99, 100, 120, 160]) {
    tmux('resize-window', '-t', 'quota', '-x', String(width), '-y', '24');
    const before = await waitFor(lines => width < 100 ? lines[2].includes('● OpenCode Go') &&
      lines[22] === (width >= 77 ? '[r] Refresh  [g] Toggle Google details  [q] Exit' : '[r] [g] [q]')
      : lines[2].startsWith('┌') && lines[2].length === width - 1);
    for (const [key, seconds] of [['a', 60], ['b', 59], ['c', 10], ['d', 9], ['z', 1], ['f', 60]]) {
      tmux('send-keys', '-t', 'quota', key);
      const lines = await waitFor(lines => lines[1].includes(`Refresh in ${String(seconds).padStart(2)}s`));
      assert.deepEqual(lines.slice(2), before.slice(2), `${width}/${seconds}: body changed`);
      assert.equal((lines.join('\n').match(/Refresh in/g) || []).length, 1);
      assert.equal(tmux('display-message', '-p', '-t', 'quota', '#{wrap_flag}').trim(), '1');
    }
    t.diagnostic(`PTY ${width}: 60 -> 59 -> 10 -> 9 -> 1 -> 60; body unchanged, wrapping restored`);
  }
  tmux('resize-window', '-t', 'quota', '-x', '39', '-y', '24');
  await waitFor(lines => lines[2].includes('● OpenCode Go'));
  tmux('send-keys', '-t', 'quota', 'e');
  await waitFor(lines => lines[2] === 'ROW_THREE_SENTINEL');
  assert.equal(capture()[3], '');
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
