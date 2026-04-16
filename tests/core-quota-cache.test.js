import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PresetManager } from '../src/core.js';

test('cacheQuotaResults persists OpenAI quota snapshots and exposes them through listPresets', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'opm-quota-cache-'));

  try {
    const manager = new PresetManager(configDir);
    await manager.init();

    manager.config.presets.alpha = {
      created_at: '2026-04-16T09:00:00.000Z',
      last_used: '2026-04-16T09:00:00.000Z',
      description: '',
      services: ['openai'],
      watched_services: ['openai'],
    };
    await manager._saveConfig();

    await writeFile(join(manager.presetsDir, 'alpha.json'), JSON.stringify({
      openai: {
        type: 'oauth',
        access: 'token',
      },
    }, null, 2));

    await manager.cacheQuotaResults([
      {
        provider: 'openai',
        account_id: 'acct-1',
        daily: { percent_remaining: 42 },
        weekly: { percent_remaining: 77 },
        error: null,
        presets: ['alpha (~/.config/oauth-preset-manager/presets/alpha.json)'],
      },
    ], '2026-04-16T10:00:00.000Z');

    const quotaCache = JSON.parse(await readFile(manager.quotaCacheFile, 'utf-8'));
    assert.deepEqual(quotaCache.presets.alpha, {
      provider: 'openai',
      account_id: 'acct-1',
      daily_percent: 42,
      weekly_percent: 77,
      last_attempt_at: '2026-04-16T10:00:00.000Z',
      last_success_at: '2026-04-16T10:00:00.000Z',
      last_error: null,
    });

    const presets = await manager.listPresets();
    assert.deepEqual(presets[0].quota_snapshot, quotaCache.presets.alpha);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('cacheQuotaResults preserves last successful quota while recording later errors', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'opm-quota-cache-'));

  try {
    const manager = new PresetManager(configDir);
    await manager.init();

    await manager.cacheQuotaResults([
      {
        provider: 'openai',
        account_id: 'acct-1',
        daily: { percent_remaining: 42 },
        weekly: { percent_remaining: 77 },
        error: null,
        presets: ['alpha (~/.config/oauth-preset-manager/presets/alpha.json)'],
      },
    ], '2026-04-16T10:00:00.000Z');

    await manager.cacheQuotaResults([
      {
        provider: 'openai',
        account_id: 'acct-1',
        daily: null,
        weekly: null,
        error: 'OpenAI API error: timeout',
        presets: ['alpha (~/.config/oauth-preset-manager/presets/alpha.json)'],
      },
    ], '2026-04-16T11:00:00.000Z');

    assert.deepEqual(manager.quotaCache.presets.alpha, {
      provider: 'openai',
      account_id: 'acct-1',
      daily_percent: 42,
      weekly_percent: 77,
      last_attempt_at: '2026-04-16T11:00:00.000Z',
      last_success_at: '2026-04-16T10:00:00.000Z',
      last_error: 'OpenAI API error: timeout',
    });
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('cacheQuotaResults keeps exact preset names even when they contain parentheses', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'opm-quota-cache-'));

  try {
    const manager = new PresetManager(configDir);
    await manager.init();

    await manager.cacheQuotaResults([
      {
        provider: 'openai',
        account_id: 'acct-1',
        daily: { percent_remaining: 42 },
        weekly: { percent_remaining: 77 },
        error: null,
        preset_names: ['alpha (team)'],
        presets: ['alpha (team) (~/.config/oauth-preset-manager/presets/alpha (team).json)'],
      },
    ], '2026-04-16T10:00:00.000Z');

    assert.equal(manager.quotaCache.presets['alpha (team)'].daily_percent, 42);
    assert.equal(manager.quotaCache.presets.alpha, undefined);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});

test('manager reloads persisted quota cache on init', async () => {
  const configDir = await mkdtemp(join(tmpdir(), 'opm-quota-cache-'));

  try {
    const manager = new PresetManager(configDir);
    await manager.init();

    manager.config.presets.alpha = {
      created_at: '2026-04-16T09:00:00.000Z',
      last_used: '2026-04-16T09:00:00.000Z',
      description: '',
      services: ['openai'],
      watched_services: ['openai'],
    };
    await manager._saveConfig();

    await writeFile(join(manager.presetsDir, 'alpha.json'), JSON.stringify({
      openai: {
        type: 'oauth',
        access: 'token',
      },
    }, null, 2));

    await manager.cacheQuotaResults([
      {
        provider: 'openai',
        account_id: 'acct-1',
        daily: { percent_remaining: 42 },
        weekly: { percent_remaining: 77 },
        error: null,
        presets: ['alpha (~/.config/oauth-preset-manager/presets/alpha.json)'],
      },
    ], '2026-04-16T10:00:00.000Z');

    const reloaded = new PresetManager(configDir);
    await reloaded.init();
    const presets = await reloaded.listPresets();

    assert.equal(presets[0].quota_snapshot?.daily_percent, 42);
    assert.equal(presets[0].quota_snapshot?.weekly_percent, 77);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
});
