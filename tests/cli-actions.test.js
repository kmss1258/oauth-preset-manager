import assert from 'node:assert/strict';
import test from 'node:test';

import { buildInteractiveChoices, buildPresetQuotaSummary, normalizeQuotaActionKey, normalizeQuotaResults, QUOTA_FOOTER_TEXT } from '../src/cli.js';

test('interactive choices include the OpenAI kickoff action', () => {
  const choices = buildInteractiveChoices([]);
  const values = choices.filter(choice => choice && typeof choice === 'object' && 'value' in choice).map(choice => choice.value);

  assert.ok(values.includes('__openai_kickoff__'));
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
