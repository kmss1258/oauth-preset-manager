import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import chalk from 'chalk';

import { buildInteractiveChoices, buildPresetQuotaSummary, formatCommandCodeAccountCell, formatCommandCodeResetCell, formatOpenCodeGoAccountCell, formatPercent, formatQuotaCountdownLine, formatQuotaRefreshCountdown, getQuotaRefreshCountdownSeconds, getQuotaTableRowItems, isRainbowQuotaEligible, normalizeQuotaActionKey, normalizeQuotaResults, summarizeOpenAIRefreshResults, updateQuotaCountdownLine, QUOTA_FOOTER_TEXT, QUOTA_REFRESH_INTERVAL_MS, waitForQuotaKeypress } from '../src/cli.js';
import { setLanguage } from '../src/i18n.js';

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

test('countdown tick updates only the saved countdown line', () => {
  const writes = [];
  const output = { write: value => writes.push(value) };
  const now = new Date(2026, 7, 17, 14, 5, 6);

  assert.equal(formatQuotaCountdownLine(12, now), '  Current 14:05:06 · Auto-refresh in 12s');
  updateQuotaCountdownLine(11, output, now);
  assert.deepEqual(writes, ['\u001b8\u001b[2K\r  Current 14:05:06 · Auto-refresh in 11s\u001b[u']);
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
