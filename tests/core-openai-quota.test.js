import assert from 'node:assert/strict';
import test from 'node:test';

import { PresetManager } from '../src/core.js';

function makeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

test('OpenAI quota uses live wham plan_type for Pro detection metadata', async () => {
  const manager = new PresetManager('/tmp/opm-unused-config');
  const access = makeJwt({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-live',
      chatgpt_plan_type: 'plus',
    },
  });

  manager._requestJson = async () => ({
    plan_type: 'pro',
    rate_limit: {
      primary_window: { used_percent: 40, reset_after_seconds: 3600 },
      secondary_window: { used_percent: 10, reset_after_seconds: 7200 },
    },
  });

  const result = await manager._fetchOpenAIQuotaForToken(access, Date.now() + 60_000, null, 10, 'plus');

  assert.equal(result.provider, 'openai');
  assert.equal(result.account_id, 'acct-live');
  assert.equal(result.plan_type, 'pro');
  assert.equal(result.plan_type_source, 'usage');
  assert.equal(result.daily.percent_remaining, 60);
  assert.equal(result.weekly.percent_remaining, 90);
  assert.equal(result.error, null);
});

test('expired OpenAI tokens keep auth plan metadata but remain ineligible for rainbow UI', async () => {
  const manager = new PresetManager('/tmp/opm-unused-config');

  const result = await manager._fetchOpenAIQuotaForToken('expired-token', Date.now() - 1, 'acct-expired', 10, 'pro');

  assert.equal(result.provider, 'openai');
  assert.equal(result.account_id, 'acct-expired');
  assert.equal(result.plan_type, 'pro');
  assert.equal(result.plan_type_source, 'auth');
  assert.equal(result.error, 'Token expired');
});
