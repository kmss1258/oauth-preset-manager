import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import chalk from 'chalk';

import { buildInteractiveChoices, buildPresetQuotaSummary, formatCommandCodeAccountCell, formatCommandCodeResetCell, formatOpenCodeGoAccountCell, formatPercent, formatPeakCountdown, formatPeakStatus, formatQuotaCountdownLine, formatQuotaRefreshCountdown, getPeakState, getQuotaRefreshCountdownSeconds, getQuotaTableRowItems, isRainbowQuotaEligible, normalizeQuotaActionKey, normalizeQuotaResults, summarizeOpenAIRefreshResults, updateQuotaCountdownLine, QUOTA_FOOTER_TEXT, QUOTA_REFRESH_INTERVAL_MS, waitForQuotaKeypress } from '../src/cli.js';
import { setLanguage } from '../src/i18n.js';

const ESC = String.fromCharCode(27);

test('interactive choices include the OpenAI kickoff action', () => {
  const choices = buildInteractiveChoices([]);
  const values = choices.filter(choice => choice && typeof choice === 'object' && 'value' in choice).map(choice => choice.value);

  assert.ok(values.includes('__openai_kickoff__'));
  assert.ok(values.includes('__propagate_oauth__'));
});

test('quota key normalization accepts ㄱ as refresh', () => {
  assert.equal(normalizeQuotaActionKey('r'), 'r');
  assert.equal(normalizeQuotaActionKey('R'), 'r');
  assert.equal(normalizeQuotaActionKey('ㄱ'), 'r');
  assert.equal(normalizeQuotaActionKey('g'), 'g');
  assert.equal(normalizeQuotaActionKey('q'), 'q');
  assert.equal(normalizeQuotaActionKey('x'), null);
});

test('quota footer text stays unchanged', () => {
  assert.equal(QUOTA_FOOTER_TEXT, '  [r] Refresh  [g] Toggle Google details  [q] Exit');
});

test('quota countdown uses ceil and never goes below zero', () => {
  const deadline = 60_000;
  assert.equal(getQuotaRefreshCountdownSeconds(deadline, 0), 60);
  assert.equal(getQuotaRefreshCountdownSeconds(deadline, 1), 60);
  assert.equal(getQuotaRefreshCountdownSeconds(deadline, 1_001), 59);
  assert.equal(getQuotaRefreshCountdownSeconds(deadline, 60_001), 0);
  assert.equal(QUOTA_REFRESH_INTERVAL_MS, 60_000);
});

test('quota countdown is translated in English and Korean', () => {
  setLanguage('en');
  assert.equal(formatQuotaRefreshCountdown(12), 'Auto-refresh in 12s');
  setLanguage('ko');
  assert.equal(formatQuotaRefreshCountdown(12), '12초 후 자동 새로고침');
  setLanguage('en');
});

test('peak state uses UTC daily boundaries and exposes the KST schedule', () => {
  const before = getPeakState(Date.UTC(2026, 7, 17, 0, 0, 0));
  assert.equal(before.phase, 'pre-alert');
  assert.equal(before.secondsRemaining, 3600);

  assert.equal(getPeakState(Date.UTC(2026, 7, 17, 1, 0, 0)).phase, 'active');
  assert.equal(getPeakState(Date.UTC(2026, 7, 17, 4, 0, 0)).phase, 'off');
  assert.equal(getPeakState(Date.UTC(2026, 7, 17, 5, 0, 0)).phase, 'pre-alert');
  assert.equal(getPeakState(Date.UTC(2026, 7, 17, 6, 0, 0)).phase, 'active');
  assert.equal(getPeakState(Date.UTC(2026, 7, 17, 10, 0, 0)).phase, 'off');
  assert.equal(getPeakState(Date.UTC(2026, 7, 17, 15, 0, 0)).phase, 'off');
  assert.equal(formatPeakStatus(getPeakState(Date.UTC(2026, 7, 17, 0, 30, 0))), 'Peak entry warning · starts in 00:30:00');
});

test('Korean peak labels are exact and retain countdown/schedule details', () => {
  setLanguage('ko');
  assert.equal(formatPeakStatus(getPeakState(Date.UTC(2026, 7, 17, 0, 30, 0))), '피크 진입 주의 · 00:30:00 후 시작');
  assert.equal(formatPeakStatus(getPeakState(Date.UTC(2026, 7, 17, 1, 30, 0))), '피크 모드 활성 · 02:30:00 후 종료');
  assert.equal(formatPeakStatus(getPeakState(Date.UTC(2026, 7, 17, 12, 0, 0))), '피크 어림 없음 · 일정: UTC 01:00–04:00, 06:00–10:00 / ☀️ KST 10:00–13:00, 🏢 KST 15:00–19:00');
  setLanguage('en');
});

test('peak countdown formatting uses readable minute and second units', () => {
  assert.equal(formatPeakCountdown(3600), '01:00:00');
  assert.equal(formatPeakCountdown(1800), '00:30:00');
  assert.equal(formatPeakCountdown(1), '00:00:01');
});

test('countdown tick updates only the saved countdown line', () => {
  const writes = [];
  const output = { write: value => writes.push(value) };
  const now = new Date(Date.UTC(2026, 7, 17, 14, 5, 6));

  assert.match(formatQuotaCountdownLine(12, now), new RegExp(`Current KST 23:05:06 🌙 · ${formatPeakStatus(getPeakState(now))} · Auto-refresh in 12s`));
  updateQuotaCountdownLine(11, output, now);
  assert.match(writes[0], new RegExp(`${ESC}8${ESC}\\[2K\\r  Current KST 23:05:06 🌙 · .* · Auto-refresh in 11s${ESC}\\[u`));
});

test('active peak status border rotates in TTY output and stays off otherwise', () => {
  const now = new Date(Date.UTC(2026, 7, 17, 1, 0, 1));
  const tty = { isTTY: true };
  const plain = { isTTY: false };
  const originalNoColor = process.env.NO_COLOR;
  const originalCi = process.env.CI;
  try {
    delete process.env.NO_COLOR;
    delete process.env.CI;
    const first = formatQuotaCountdownLine(12, now, getPeakState(now), { output: tty, interactive: true });
    const next = formatQuotaCountdownLine(12, new Date(now.getTime() + 1000), getPeakState(now.getTime() + 1000), { output: tty, interactive: true });
    assert.match(first, new RegExp(`${ESC}\\[38;2;\\d+;\\d+;\\d+m│`));
    assert.notEqual(first, next);
    assert.doesNotMatch(formatQuotaCountdownLine(12, now, getPeakState(now), { output: tty }), new RegExp(`${ESC}\\[`));
    assert.doesNotMatch(formatQuotaCountdownLine(12, now, getPeakState(now), { output: tty, interactive: false }), new RegExp(`${ESC}\\[`));
    assert.doesNotMatch(formatQuotaCountdownLine(12, now, getPeakState(now), { output: plain }), new RegExp(`${ESC}\\[`));
  } finally {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  }
});

test('quota status line omits refresh countdown when refresh is disabled', () => {
  const now = new Date(Date.UTC(2026, 7, 17, 14, 5, 6));
  const line = formatQuotaCountdownLine(null, now, getPeakState(now), { output: { isTTY: false } });
  assert.match(line, /Current KST 23:05:06 🌙/);
  assert.doesNotMatch(line, /Auto-refresh/);
  assert.doesNotMatch(line, new RegExp(`${ESC}\\[`));
});

test('KST status line uses sun and moon at exact day/night boundaries', () => {
  const statusAt = (hour, minute) => formatQuotaCountdownLine(
    null,
    new Date(Date.UTC(2026, 7, 16, hour, minute)),
    { phase: 'off' },
    { output: { isTTY: false }, interactive: false },
  );

  assert.match(statusAt(20, 59), /Current KST 05:59:00 🌙/);
  assert.match(statusAt(21, 0), /Current KST 06:00:00 ☀️/);
  assert.match(statusAt(8, 59), /Current KST 17:59:00 ☀️/);
  assert.match(statusAt(9, 0), /Current KST 18:00:00 🌙/);
});

test('peak status colors distinguish off, pre-alert, and active states', () => {
  const previousLevel = chalk.level;
  const originalNoColor = process.env.NO_COLOR;
  const originalCi = process.env.CI;
  const output = { isTTY: false };
  try {
    setLanguage('ko');
    chalk.level = 1;
    delete process.env.NO_COLOR;
    delete process.env.CI;
    const off = formatQuotaCountdownLine(null, new Date(Date.UTC(2026, 7, 17, 12, 0, 0)), getPeakState(Date.UTC(2026, 7, 17, 12, 0, 0)), { output, interactive: false });
    const preAlert = formatQuotaCountdownLine(null, new Date(Date.UTC(2026, 7, 17, 0, 30, 0)), getPeakState(Date.UTC(2026, 7, 17, 0, 30, 0)), { output, interactive: false });
    const active = formatQuotaCountdownLine(null, new Date(Date.UTC(2026, 7, 17, 1, 30, 0)), getPeakState(Date.UTC(2026, 7, 17, 1, 30, 0)), { output, interactive: false });
    assert.match(off, new RegExp(`${ESC}\\[32m피크 어림 없음`));
    assert.match(preAlert, new RegExp(`${ESC}\\[33m피크 진입 주의`));
    assert.match(active, new RegExp(`${ESC}\\[31m피크 모드 활성`));
  } finally {
    setLanguage('en');
    chalk.level = previousLevel;
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  }
});

test('active peak border respects NO_COLOR and CI', () => {
  const now = new Date(Date.UTC(2026, 7, 17, 1, 0, 1));
  const originalNoColor = process.env.NO_COLOR;
  const originalCi = process.env.CI;
  try {
    process.env.NO_COLOR = '1';
    assert.doesNotMatch(formatQuotaCountdownLine(12, now, getPeakState(now), { output: { isTTY: true } }), new RegExp(`${ESC}\\[`));
    delete process.env.NO_COLOR;
    process.env.CI = '1';
    assert.doesNotMatch(formatQuotaCountdownLine(12, now, getPeakState(now), { output: { isTTY: true } }), new RegExp(`${ESC}\\[`));
  } finally {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
  }
});

function withFakeStdin(run) {
  const originalStdin = process.stdin;
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.paused = true;
  stdin.isPaused = () => stdin.paused;
  stdin.setRawMode = value => { stdin.isRaw = value; };
  stdin.resume = () => { stdin.paused = false; };
  stdin.pause = () => { stdin.paused = true; };
  Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });

  return Promise.resolve()
    .then(run)
    .finally(() => Object.defineProperty(process, 'stdin', { configurable: true, value: originalStdin }));
}

test('timed quota keypress removes listener and restores raw and pause state', async () => {
  await withFakeStdin(async () => {
    const action = await waitForQuotaKeypress(5);
    assert.equal(action, 'timeout');
    assert.equal(process.stdin.listenerCount('data'), 0);
    assert.equal(process.stdin.isRaw, false);
    assert.equal(process.stdin.isPaused(), true);
  });
});

test('quota keypress wins a timeout race without a second resolution', async () => {
  await withFakeStdin(async () => {
    const actionPromise = waitForQuotaKeypress(20);
    process.stdin.emit('data', Buffer.from('r'));
    assert.equal(await actionPromise, 'r');
    assert.equal(process.stdin.listenerCount('data'), 0);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(process.stdin.listenerCount('data'), 0);
  });
});

test('quota normalization preserves distinct preset rows for the same OpenAI account', () => {
  const results = [
    {
      provider: 'openai',
      account_id: 'b5d2fa5a-ecc9-4f4f-bd1f-4887358e68b2',
      nickname: '260415_buts2_260421',
      presets: ['260415_buts2_260421 (~/.config/oauth-preset-manager/presets/260415_buts2_260421.json)'],
      daily: { percent_remaining: 11 },
      weekly: { percent_remaining: 40 },
    },
    {
      provider: 'openai',
      account_id: 'b5d2fa5a-ecc9-4f4f-bd1f-4887358e68b2',
      nickname: '260415_buts2_2_260425',
      presets: ['260415_buts2_2_260425 (~/.config/oauth-preset-manager/presets/260415_buts2_2_260425.json)'],
      daily: { percent_remaining: 0 },
      weekly: { percent_remaining: 6 },
    },
  ];

  const normalized = normalizeQuotaResults(results);

  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized.map(result => result.nickname), [
    '260415_buts2_2_260425',
    '260415_buts2_260421',
  ]);
});

test('interactive choices show cached OpenAI quota summary next to preset names', () => {
  const choices = buildInteractiveChoices([
    {
      name: 'alpha',
      is_current: true,
      description: '',
      quota_snapshot: {
        provider: 'openai',
        daily_percent: 42,
        weekly_percent: 77,
        last_success_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        last_attempt_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        last_error: null,
      },
    },
  ]);

  assert.match(choices[0].name, /alpha/);
  assert.match(choices[0].name, /OAI D42% W77%/);
});

test('preset quota summary marks stale cached data after an error', () => {
  const summary = buildPresetQuotaSummary({
    quota_snapshot: {
      provider: 'openai',
      daily_percent: 42,
      weekly_percent: 77,
      last_success_at: '2026-04-16T09:00:00.000Z',
      last_attempt_at: '2026-04-16T10:00:00.000Z',
      last_error: 'OpenAI API error: timeout',
    },
  }, new Date('2026-04-16T10:30:00.000Z'));

  assert.deepEqual(summary, {
    text: summary.text,
    plainText: 'OAI D42% W77% · stale · 1h ago · OpenAI API error: timeout',
    tone: 'warn',
  });
  assert.match(summary.text, /D42%/);
  assert.match(summary.text, /W77%/);
});


const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, '');
}

test('rainbow quota eligibility requires live usable OpenAI Pro usage', () => {
  assert.equal(isRainbowQuotaEligible({
    provider: 'openai',
    plan_type: 'pro',
    plan_type_source: 'usage',
    error: null,
  }), true);

  assert.equal(isRainbowQuotaEligible({
    provider: 'openai',
    plan_type: 'prolite',
    plan_type_source: 'usage',
    error: null,
  }), true);

  assert.equal(isRainbowQuotaEligible({
    provider: 'openai',
    plan_type: 'pro',
    plan_type_source: 'auth',
    error: null,
  }), false);

  assert.equal(isRainbowQuotaEligible({
    provider: 'openai',
    plan_type: 'pro',
    plan_type_source: 'usage',
    error: 'Token expired',
  }), false);

  assert.equal(isRainbowQuotaEligible({
    provider: 'openai',
    plan_type: 'plus',
    plan_type_source: 'usage',
    error: null,
  }), false);
});

test('Pro gradient quota bar preserves visible width and percent text', () => {
  const plain = formatPercent(60);
  const rainbow = formatPercent(60, { rainbow: 'force' });

  assert.ok(rainbow.includes(`${String.fromCharCode(27)}[38;2;`));
  assert.equal(rainbow.includes(`${String.fromCharCode(27)}[38;5;196m`), false);
  assert.equal(stripAnsi(rainbow), stripAnsi(plain));
});


test('Pro gradient quota bar stays plain in non-TTY captures', () => {
  const plain = formatPercent(60);
  const captured = formatPercent(60, { rainbow: true });

  assert.equal(captured, plain);
});

test('OpenCode Go account cell includes monthly quota summary', () => {
  const cell = stripAnsi(formatOpenCodeGoAccountCell({
    provider: 'opencodego',
    account_id: 'wrk_123',
    monthly_percent: 64,
    monthly_reset_iso: '2026-07-28T00:00:00.000Z',
  }));

  assert.match(cell, /^wrk_123\nM /);
  assert.match(cell, /64%/);
  assert.match(cell, /·/);
});

test('Command Code account cell includes credits, usage, and renewal', () => {
  const cell = formatCommandCodeAccountCell({
    provider: 'commandcode',
    account_id: 'org_test',
    nickname: 'tester',
    command_code_credits: { total_remaining: 13 },
    command_code_usage: { total_count: 42, total_tokens: 123456, total_cost: 12.34 },
    command_code_period: { end: '2026-09-01T00:00:00.000Z' },
  });

  assert.match(cell, /tester/);
  assert.equal(stripAnsi(cell), 'tester\n123,456 tokens');

  const weeklyReset = stripAnsi(formatCommandCodeResetCell({
    command_code_usage: { total_cost: 12.34 },
  }, { reset_time_iso: '2026-08-21T00:00:00.000Z' }));

  assert.match(weeklyReset, /\$12\.34 used/);
});

test('OpenCode Go narrow account cell includes weekly and monthly quota summaries', () => {
  const cell = stripAnsi(formatOpenCodeGoAccountCell({
    provider: 'opencodego',
    account_id: 'wrk_123',
    weekly: {
      percent_remaining: 82,
      reset_time_iso: '2026-07-28T00:00:00.000Z',
    },
    monthly_percent: 64,
    monthly_reset_iso: '2026-08-01T00:00:00.000Z',
  }, { includeWeekly: true }));

  assert.match(cell, /^wrk_123\nW /);
  assert.match(cell, /82%/);
  assert.match(cell, /\nM /);
  assert.match(cell, /64%/);
});

test('OpenCode Go quota bars use cyan fill while warning percents stay red and yellow', () => {
  const previousLevel = chalk.level;
  chalk.level = 1;

  try {
    const cell = formatOpenCodeGoAccountCell({
      provider: 'opencodego',
      account_id: 'wrk_123',
      weekly: {
        percent_remaining: 42,
        reset_time_iso: '2026-07-28T00:00:00.000Z',
      },
      monthly_percent: 12,
      monthly_reset_iso: '2026-08-01T00:00:00.000Z',
    }, { includeWeekly: true });

    const ansi = String.fromCharCode(27);
    assert.match(cell, new RegExp(`${ansi}\\[36m█+`));
    assert.doesNotMatch(cell, new RegExp(`${ansi}\\[32m█+`));
    assert.match(cell, new RegExp(`${ansi}\\[33m\\s*42%`));
    assert.match(cell, new RegExp(`${ansi}\\[31m\\s*12%`));
    assert.match(formatPercent(60), new RegExp(`${ansi}\\[32m█+`));
  } finally {
    chalk.level = previousLevel;
  }
});

test('quota table toggle keeps OpenCode Go as a normal non-Google row', () => {
  const rows = getQuotaTableRowItems([
    { provider: 'openai', account_id: 'openai-1' },
    { provider: 'google', account_id: 'google-1' },
    { provider: 'opencodego', account_id: 'wrk_123' },
  ], false);

  assert.deepEqual(rows.map(row => row.provider), ['openai', 'opencodego']);
});

test('OpenAI refresh summary counts successes and failures', () => {
  assert.deepEqual(summarizeOpenAIRefreshResults([
    { success: true },
    { success: false },
    { success: true },
  ]), {
    total: 3,
    succeeded: 2,
    failed: 1,
  });
  assert.equal(summarizeOpenAIRefreshResults([]), null);
});
