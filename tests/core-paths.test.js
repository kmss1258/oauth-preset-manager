import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PresetManager,
  getAntigravityAccountsPathCandidates,
  getOpenCodeAuthPathCandidates,
} from '../src/core.js';

function withEnv(updates, fn) {
  const saved = new Map();

  for (const [key, value] of Object.entries(updates)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    fn();
  } finally {
    for (const [key, value] of saved.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('uses XDG-style auth paths by default', () => {
  const candidates = getOpenCodeAuthPathCandidates('/Users/alice');

  assert.deepEqual(candidates, [
    '/Users/alice/.local/share/opencode/auth.json',
    '/Users/alice/.config/opencode/auth.json',
  ]);
});

test('honors XDG overrides for application support paths', () => {
  withEnv(
    {
      XDG_DATA_HOME: '/Users/alice/Library/Application Support',
      XDG_CONFIG_HOME: '/Users/alice/Library/Preferences',
    },
    () => {
      const candidates = getOpenCodeAuthPathCandidates('/Users/alice');

      assert.deepEqual(candidates, [
        '/Users/alice/Library/Application Support/opencode/auth.json',
        '/Users/alice/Library/Preferences/opencode/auth.json',
      ]);
    }
  );
});

test('keeps antigravity paths aligned with XDG config/data dirs', () => {
  const candidates = getAntigravityAccountsPathCandidates('/Users/alice');

  assert.deepEqual(candidates, [
    '/Users/alice/.config/opencode/antigravity-accounts.json',
    '/Users/alice/.local/share/opencode/antigravity-accounts.json',
  ]);
});

test('lets an explicit auth override win at runtime', () => {
  withEnv({ OPM_AUTH_PATH: '/tmp/opencode-auth.json' }, () => {
    const manager = new PresetManager('/tmp/oauth-preset-manager');
    manager.config = { auth_path: '/Users/alice/.local/share/opencode/auth.json' };

    assert.equal(manager.getAuthPath(), '/tmp/opencode-auth.json');
  });
});
