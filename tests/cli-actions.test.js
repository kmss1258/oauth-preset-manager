import assert from 'node:assert/strict';
import test from 'node:test';

import { buildInteractiveChoices, normalizeQuotaActionKey, normalizeQuotaResults, QUOTA_FOOTER_TEXT } from '../src/cli.js';

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
