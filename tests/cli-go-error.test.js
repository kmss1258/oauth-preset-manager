import assert from 'node:assert/strict';
import test from 'node:test';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { buildQuotaFrame } from '../src/cli.js';
import { buildSidebarView } from '../src/sidebar-view.js';
import { normalizeSidebarSettings } from '../src/sidebar-settings.js';

const error = 'Go usage error: 이 키의 사용자/workspace에 구독 권한이 없습니다.\n' + 'details '.repeat(40);
const result = { provider: 'opencodego', account_id: 'OpenCode Go', presets: ['(Current Active)'], error,
  daily: null, weekly: null, monthly_percent: null, monthly_reset_iso: null };

test('Go errors occupy at most two table lines and omit unavailable monthly detail', () => {
  for (const columns of [100, 130, 220]) {
    const lines = buildQuotaFrame([result], { columns }).lines.map(stripAnsi);
    const cells = lines.filter(line => line.startsWith('│')).slice(1);
    assert.equal(cells.length, 2);
    const errors = cells.map(line => line.split('│')[2].trim());
    assert.ok(errors.every(line => stringWidth(line) <= 16));
    assert.ok(errors[1].endsWith('…'));
    assert.ok(!lines.some(line => line.includes('M -')));
  }
});

test('Go errors also cap at two lines on narrow screens', () => {
  for (const columns of [30, 50, 80]) {
    const lines = buildQuotaFrame([result], { columns }).lines.map(stripAnsi);
    const start = lines.findIndex(line => line.startsWith('Go usage error:'));
    assert.ok(start >= 0);
    assert.equal(lines.length - start, 2);
    assert.ok(lines.at(-1).endsWith('…'));
  }
});

test('weekly CX uses label, window, bar, percent, reset with exactly one visible token', () => {
  const settings = normalizeSidebarSettings({ claude: false, disk: false, ram: false, gpu: false });
  for (const percent of [75, 20, 10]) {
    const view = buildSidebarView(settings, [{ provider: 'codex', status: 'ok', percent, window: '7d', resetAt: 8040001 }], {}, 1);
    const visible = view.rows[0].map(part => view.tokens[part.token.slice(1)]).filter(Boolean);
    assert.equal(visible.length, 1);
    assert.match(visible[0], new RegExp(`^CX 7d [▰▱]{4} ${percent}% 2h14m$`));
    assert.ok(stringWidth(visible[0]) <= 22);
  }
});
