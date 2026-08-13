import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PresetManager } from '../src/core.js';

function makeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.`;
}

test('runOpenAIKickoffBatch targets unique OpenAI auth entries only', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'opm-kickoff-'));

  try {
    const manager = new PresetManager(configDir);
    await manager.init();

    const currentAuthPath = join(configDir, 'current-auth.json');
    manager.config.auth_path = currentAuthPath;
    await manager._saveConfig();

    const openAiPayload = {
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-1',
        chatgpt_user_id: 'user-1',
        chatgpt_plan_type: 'team',
      },
      'https://api.openai.com/profile': {
        email: 'one@example.com',
      },
    };

    const sharedAccess = makeJwt(openAiPayload);
    const sharedRefresh = 'refresh-1';

    await mkdir(manager.presetsDir, { recursive: true });
    await writeFile(currentAuthPath, JSON.stringify({
      openai: {
        type: 'oauth',
        access: sharedAccess,
        refresh: sharedRefresh,
        expires: Date.now() + 60_000,
        accountId: 'acct-1',
      },
    }, null, 2));

    await writeFile(join(manager.presetsDir, 'alpha.json'), JSON.stringify({
      openai: {
        type: 'oauth',
        access: sharedAccess,
        refresh: sharedRefresh,
        expires: Date.now() + 60_000,
        accountId: 'acct-1',
      },
    }, null, 2));

    await writeFile(join(manager.presetsDir, 'google-only.json'), JSON.stringify({
      google: {
        type: 'oauth',
        access: 'google-access',
      },
    }, null, 2));

    const calls = [];
    manager._requestJson = async (url, options) => {
      calls.push({ url, options });
      return { output_text: 'OK' };
    };

    const batch = await manager.runOpenAIKickoffBatch();

    assert.equal(batch.model, 'gpt-5.6-luna');
    assert.equal(batch.results.length, 1);
    assert.equal(batch.results[0].error, null);
    assert.equal(batch.results[0].output_text, 'OK');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');

    const body = JSON.parse(calls[0].options.body);
    assert.deepEqual(body, {
      model: 'gpt-5.6-luna',
      instructions: 'Reply with exactly OK.',
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Reply with exactly OK.',
            },
          ],
        },
      ],
      stream: true,
      store: false,
    });
    assert.equal(calls[0].options.headers['ChatGPT-Account-Id'], 'acct-1');
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
