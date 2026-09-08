import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import https from 'node:https';
import { EventEmitter } from 'node:events';

import { PresetManager } from '../src/core.js';
import { runOpenAIKickoffInteractive } from '../src/cli.js';
import { setLanguage, t } from '../src/i18n.js';

async function setup(context) {
  const dir = await mkdtemp(join(tmpdir(), 'opm-kickoff-outcome-'));
  const originalAuthPath = process.env.OPM_AUTH_PATH;
  const originalExitCode = process.exitCode;
  process.env.OPM_AUTH_PATH = join(dir, 'active.json');
  context.after(async () => {
    if (originalAuthPath === undefined) delete process.env.OPM_AUTH_PATH; else process.env.OPM_AUTH_PATH = originalAuthPath;
    process.exitCode = originalExitCode;
    setLanguage('en');
    await rm(dir, { recursive: true, force: true });
  });
  const manager = new PresetManager(join(dir, 'opm'));
  await manager.init();
  manager._requestJson = async () => assert.fail('Unexpected network request');
  return { dir, manager };
}

function target(name = 'one') {
  return { type: 'oauth', access: `TEST-access-${name}`, refresh: `TEST-refresh-${name}`, expires: Date.now() + 3600_000,
    accountId: 'TEST-workspace', account_id: 'TEST-workspace', opm_identity: { account: 'TEST-workspace', sub: name, user: name },
    nickname: name, presets: [name] };
}

function event(type, value = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

const completed = () => event('response.completed', { response: { status: 'completed', output: [
  { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK' }] },
] } });

async function captureKickoff(manager) {
  const original = { log: console.log, error: console.error, clear: console.clear };
  const output = [];
  console.log = console.error = (...args) => output.push(args.map(String).join(' '));
  console.clear = () => {};
  try { await runOpenAIKickoffInteractive(manager); }
  finally { Object.assign(console, original); }
  return output.join('\n').replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

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
    assert.equal(batch.results[0].stage, 'inference');
    assert.equal(batch.results[0].inference_attempted, true);
    assert.equal(batch.results[0].inference_completed, true);
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

test('auth failure reports no inference attempted and never calls the responses endpoint', async context => {
  const { manager } = await setup(context);
  const expired = { ...target(), expires: Date.now() - 1 };
  const requests = [];
  manager._requestJson = async url => {
    requests.push(url);
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    throw Object.assign(new Error('TEST-SECRET refresh body Cookie: hidden'), { statusCode: 401 });
  };
  const result = await manager._runOpenAIKickoffForTarget(expired);
  assert.deepEqual(requests, ['https://auth.openai.com/oauth/token']);
  assert.equal(result.stage, 'auth');
  assert.equal(result.inference_attempted, false);
  assert.equal(result.inference_completed, false);
  assert.equal(result.output_text, null);
  assert.ok(result.error);
  assert.doesNotMatch(JSON.stringify(result), /TEST-SECRET|Cookie:|TEST-access|TEST-refresh/);
});

test('completed SSE confirms generation once without duplicating deltas or changing the inference payload', async context => {
  const { manager } = await setup(context);
  const requests = [];
  manager._requestJson = async (url, options, timeout) => {
    requests.push(url);
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer TEST-access-one');
    assert.equal(options.headers['ChatGPT-Account-Id'], 'TEST-workspace');
    assert.equal(timeout, 7000);
    assert.deepEqual(JSON.parse(options.body), {
      model: 'gpt-5.6-luna', instructions: 'Reply with exactly OK.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly OK.' }] }],
      stream: true, store: false,
    });
    return (event('response.output_text.delta', { delta: 'O' }) + event('response.output_text.delta', { delta: 'K' })
      + completed() + 'data: [DONE]\n\n').replace(/\n/g, '\r\n');
  };
  const result = await manager._runOpenAIKickoffForTarget(target(), 7);
  assert.equal(requests.length, 1);
  assert.equal(result.inference_attempted, true);
  assert.equal(result.inference_completed, true);
  assert.equal(result.stage, 'inference');
  assert.equal(result.output_text, 'OK');
  assert.equal(result.error, null);
});

test('HTTP 200 SSE failures, incomplete responses and truncated streams never count as completed', async context => {
  const { manager } = await setup(context);
  const secret = 'TEST-SECRET Cookie: private Bearer TEST-access-one';
  const cases = [
    [event('error', { code: 'rate_limit_exceeded', message: secret }), 'rate_limit_exceeded'],
    [event('response.failed', { response: { status: 'failed', error: { code: 'server_error', message: secret } } }), 'server_error'],
    [event('response.incomplete', { response: { status: 'incomplete', output_text: secret, incomplete_details: { reason: 'max_output_tokens' } } }), 'max_output_tokens'],
    [event('error', { code: secret, message: secret }), 'response_failed'],
    [event('response.output_text.delta', { delta: secret }), 'stream_incomplete'],
    [event('response.output_text.done', { text: 'OK' }) + 'data: [DONE]\n\n', 'stream_incomplete'],
    [completed().trimEnd(), 'stream_incomplete'],
    [completed().slice(0, -1), 'stream_incomplete'],
    ['data: [DONE]\n\n', 'stream_incomplete'],
    [event('response.created', { response: { status: 'in_progress' } }), 'stream_incomplete'],
    [event('response.output_text.delta', { delta: 'O' }) + 'data: {"type":"response.completed","response":', 'invalid_response'],
    [completed() + 'data: {TEST-SECRET-truncated', 'invalid_response'],
    [completed() + event('error', { message: secret }), 'response_failed'],
    [event('response.completed', { response: { status: 'completed', output: [] } }), 'empty_response'],
    [event('response.completed', { response: { status: 'in_progress', output_text: 'OK' } }), 'response_incomplete'],
    [{ status: 'failed', output_text: secret }, 'response_failed'],
    [{ status: 'incomplete', output_text: secret }, 'response_incomplete'],
    [{ status: 'in_progress', output_text: 'OK' }, 'response_incomplete'],
    [{ type: 'response.output_text.delta', output_text: 'OK' }, 'response_incomplete'],
    [{ error: { code: 'server_error', message: secret }, output_text: 'OK' }, 'server_error'],
  ];
  let calls = 0;
  for (const [response, code] of cases) {
    manager._requestJson = async () => { calls++; return response; };
    const result = await manager._runOpenAIKickoffForTarget(target());
    assert.equal(result.inference_attempted, true, code);
    assert.equal(result.inference_completed, false, code);
    assert.equal(result.stage, 'inference', code);
    assert.equal(result.error_code, code);
    assert.equal(result.output_text, null, 'partial output must not be mistaken for completed output');
    assert.ok(result.error);
    assert.doesNotMatch(JSON.stringify(result), /TEST-SECRET|Cookie:|Bearer|TEST-access/);
  }
  assert.equal(calls, cases.length, 'no implicit retries');
});

test('HTTP 401, 429 and 500 expose only numeric status and allowlisted codes at inference stage', async context => {
  const { manager } = await setup(context);
  let calls = 0;
  for (const statusCode of [401, 429, 500]) {
    manager._requestJson = async () => {
      calls++;
      throw Object.assign(new Error(`HTTP ${statusCode}: TEST-SECRET Cookie: private`), {
        statusCode, code: statusCode === 429 ? 'rate_limit_exceeded' : 'TEST-SECRET-CODE', body: 'TEST-access-one',
      });
    };
    const result = await manager._runOpenAIKickoffForTarget(target());
    assert.equal(result.stage, 'inference');
    assert.equal(result.inference_attempted, true);
    assert.equal(result.inference_completed, false);
    assert.equal(result.http_status, statusCode);
    assert.equal(result.error_code, statusCode === 429 ? 'rate_limit_exceeded' : null);
    assert.equal(result.output_text, null);
    assert.doesNotMatch(JSON.stringify(result), /TEST-SECRET|TEST-access|Cookie:/);
  }
  assert.equal(calls, 3);
});

test('empty HTTP 200 or arbitrary raw response text is not generation completion', async context => {
  const { manager } = await setup(context);
  for (const response of ['', ' ', null, {}, { output_text: '' }, { status: 'completed' }, '<html>TEST-SECRET</html>', 'OK']) {
    manager._requestJson = async () => response;
    const result = await manager._runOpenAIKickoffForTarget(target());
    assert.equal(result.inference_attempted, true);
    assert.equal(result.inference_completed, false);
    assert.equal(result.output_text, null);
    assert.ok(result.error);
    assert.doesNotMatch(JSON.stringify(result), /TEST-SECRET/);
  }
});

test('aborted HTTP 200 SSE transport settles as incomplete without exposing the partial body', async context => {
  const { manager } = await setup(context);
  manager._requestJson = new PresetManager(manager.configDir)._requestJson;
  const request = https.request;
  let calls = 0;
  https.request = (_url, _options, onResponse) => {
    calls++;
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      onResponse(res);
      res.emit('data', event('response.output_text.delta', { delta: 'TEST-SECRET partial' }));
      res.emit('aborted');
      res.emit('error', new Error('TEST-SECRET socket body'));
    });
    return req;
  };
  try {
    const result = await manager._runOpenAIKickoffForTarget(target());
    assert.equal(calls, 1);
    assert.equal(result.inference_attempted, true);
    assert.equal(result.inference_completed, false);
    assert.equal(result.stage, 'inference');
    assert.equal(result.error_code, 'stream_incomplete');
    assert.equal(result.output_text, null);
    assert.doesNotMatch(JSON.stringify(result), /TEST-SECRET/);
  } finally { https.request = request; }
});

test('direct JSON completion and event-only SSE type are supported without exposing credential echoes', async context => {
  const { manager } = await setup(context);
  const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }];
  for (const response of [{ output_text: 'OK' }, { status: 'completed', output }, JSON.stringify({ status: 'completed', output }),
    'event: response.completed\ndata: {"response":\ndata: {"status":"completed","output_text":"OK"}}\n\n']) {
    manager._requestJson = async () => response;
    const result = await manager._runOpenAIKickoffForTarget(target());
    assert.equal(result.inference_completed, true);
    assert.equal(result.output_text, 'OK');
    assert.equal(result.error, null);
  }
  manager._requestJson = async () => ({ status: 'completed', output_text: 'TEST-access-one TEST-refresh-one Cookie: private' });
  const result = await manager._runOpenAIKickoffForTarget(target());
  assert.equal(result.inference_completed, true);
  assert.doesNotMatch(result.output_text, /TEST-access|TEST-refresh|Cookie:|private/);
});

test('strict collection failure carries preflight/no-inference state and never sends a suspect target', async context => {
  const { manager } = await setup(context);
  await writeFile(manager.getAuthPath(), JSON.stringify({ openai: target('one'), codex: target('other') }));
  await assert.rejects(manager.runOpenAIKickoffBatch(), error => {
    assert.equal(error.opmKey, 'sync_alias_error');
    assert.equal(error.stage, 'preflight');
    assert.equal(error.inference_attempted, false);
    assert.equal(error.inference_completed, false);
    assert.doesNotMatch(error.message, /TEST-access|TEST-refresh/);
    return true;
  });
  manager.collectOpenAIKickoffTargets = async () => { throw new Error('TEST-SECRET upstream body Cookie: private'); };
  await assert.rejects(manager.runOpenAIKickoffBatch(), error => {
    assert.equal(error.stage, 'preflight');
    assert.equal(error.inference_attempted, false);
    assert.doesNotMatch(error.message, /TEST-SECRET|Cookie:/);
    return true;
  });
});

test('one inference failure does not suppress another valid target generation in a mixed batch', async context => {
  const { manager } = await setup(context);
  for (const name of ['success', 'failure']) await writeFile(join(manager.presetsDir, `${name}.json`), JSON.stringify({ openai: target(name) }));
  const requests = [];
  manager._requestJson = async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    requests.push(options.headers.Authorization);
    if (options.headers.Authorization.endsWith('failure')) throw Object.assign(new Error('TEST-SECRET body'), { statusCode: 500 });
    return completed();
  };
  const batch = await manager.runOpenAIKickoffBatch();
  assert.equal(requests.length, 2);
  assert.equal(batch.results.length, 2);
  assert.equal(batch.results.filter(result => result.inference_attempted).length, 2);
  assert.equal(batch.results.filter(result => result.inference_completed).length, 1);
  assert.equal(batch.results.find(result => result.nickname === 'success').output_text, 'OK');
  assert.equal(batch.results.find(result => result.nickname === 'failure').http_status, 500);
  assert.doesNotMatch(JSON.stringify(batch), /TEST-SECRET|TEST-access|TEST-refresh/);
});

test('kickoff UI distinguishes attempts, completed generations, auth failures and no-target/preflight exits in EN/KO', async context => {
  const { manager } = await setup(context);
  for (const language of ['en', 'ko']) {
    setLanguage(language);
    manager._requestJson = async (url, options) => {
      if (url.endsWith('/oauth/token')) throw new Error('TEST-SECRET auth body');
      if (options.headers.Authorization.endsWith('failed-inference')) throw Object.assign(new Error('TEST-SECRET HTTP body'), { statusCode: 429 });
      return completed();
    };
    const results = await Promise.all([
      manager._runOpenAIKickoffForTarget(target('success')),
      manager._runOpenAIKickoffForTarget(target('failed-inference')),
      manager._runOpenAIKickoffForTarget({ ...target(`auth-${language}`), expires: Date.now() - 1 }),
    ]);
    const output = await captureKickoff({ runOpenAIKickoffBatch: async () => ({ model: 'gpt-5.6-luna', results }) });
    assert.ok(output.includes(`${t('openai_kickoff_attempted')}: 2`));
    assert.ok(output.includes(`${t('openai_kickoff_completed')}: 1`));
    assert.ok(output.includes(`${t('openai_kickoff_not_requested')}: 1`));
    assert.ok(output.includes(`${t('openai_kickoff_unconfirmed')}: 1`));
    assert.ok(output.includes(t('openai_kickoff_stage_auth')));
    assert.ok(output.includes(t('openai_kickoff_stage_inference')));
    assert.ok(output.includes('HTTP 429'));
    assert.ok(output.includes(t('openai_kickoff_attempt_note')));
    assert.doesNotMatch(output, /TEST-SECRET|TEST-access|TEST-refresh/);
    assert.equal(process.exitCode, 1);
    const empty = await captureKickoff({ runOpenAIKickoffBatch: async () => ({ results: [] }) });
    assert.ok(empty.includes(t('openai_kickoff_not_requested')));
    manager.collectOpenAIKickoffTargets = async () => { throw new Error('TEST-SECRET collection'); };
    const preflight = await captureKickoff(manager);
    assert.ok(preflight.includes(t('openai_kickoff_stage_preflight')));
    assert.ok(preflight.includes(t('openai_kickoff_preflight_failed')));
    assert.doesNotMatch(preflight, /TEST-SECRET/);
  }
});
