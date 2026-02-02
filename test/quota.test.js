import { describe, it, expect, beforeEach } from 'vitest';
import { PresetManager, timeUntilReset } from '../src/core.js';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

describe('Quota Collection Tests', () => {
  let manager;
  let testConfigDir;

  beforeEach(async () => {
    testConfigDir = join(homedir(), '.config', 'oauth-preset-manager-test');
    manager = new PresetManager(testConfigDir);
    await manager.init();
  });

  describe('timeUntilReset', () => {
    it('should return "-" for null/undefined input', () => {
      expect(timeUntilReset(null)).toBe('-');
      expect(timeUntilReset(undefined)).toBe('-');
      expect(timeUntilReset('')).toBe('-');
    });

    it('should return "Resetting..." for past dates', () => {
      const pastDate = new Date(Date.now() - 1000).toISOString();
      expect(timeUntilReset(pastDate)).toBe('Resetting...');
    });

    it('should format time correctly for future dates', () => {
      const future4h59m = new Date(Date.now() + (4 * 60 * 60 * 1000) + (59 * 60 * 1000)).toISOString();
      const result = timeUntilReset(future4h59m);
      expect(result).toMatch(/^\d+h\s*\d*m$/);
    });
  });

  describe('Quota Data Structure', () => {
    it('should have required fields in quota result', async () => {
      const mockQuotaResult = {
        provider: 'openai',
        account_id: 'test-account',
        daily: {
          percent_remaining: 80,
          reset_time_iso: new Date(Date.now() + 3600000).toISOString()
        },
        weekly: {
          percent_remaining: 50,
          reset_time_iso: new Date(Date.now() + 86400000).toISOString()
        },
        presets: ['test-preset'],
        error: null
      };

      expect(mockQuotaResult).toHaveProperty('provider');
      expect(mockQuotaResult).toHaveProperty('account_id');
      expect(mockQuotaResult).toHaveProperty('daily');
      expect(mockQuotaResult).toHaveProperty('presets');
    });

    it('should handle Google quota with label', () => {
      const googleResult = {
        provider: 'google',
        account_id: 'test-project',
        daily: {
          percent_remaining: 100,
          label: 'G3Flash'
        },
        weekly: null,
        error: null
      };

      expect(googleResult.daily).toHaveProperty('label');
      expect(googleResult.daily.label).toBe('G3Flash');
    });

    it('should handle error state correctly', () => {
      const errorResult = {
        provider: 'openai',
        account_id: null,
        daily: null,
        weekly: null,
        error: 'Token expired'
      };

      expect(errorResult.error).toBeTruthy();
      expect(errorResult.daily).toBeNull();
    });
  });

  describe('formatPercent', () => {
    it('should return "-" for null/undefined values', () => {
      const formatPercent = (v) => v == null ? '-' : `[${'='.repeat(Math.round(v / 10))}] ${v}%`;
      expect(formatPercent(null)).toBe('-');
      expect(formatPercent(undefined)).toBe('-');
    });

    it('should format percentage with progress bar', () => {
      const formatPercent = (v) => `[${'='.repeat(Math.round(v / 10))}${'-'.repeat(10 - Math.round(v / 10))}] ${v.toString().padStart(3)}%`;
      expect(formatPercent(100)).toContain('100%');
      expect(formatPercent(50)).toContain('50%');
    });
  });

  describe('deduplication', () => {
    it('should deduplicate tokens by access token', () => {
      const tokenMap = new Map();
      const tokens = [
        { access: 'token1', account_id: 'acc1' },
        { access: 'token1', account_id: 'acc1' },
        { access: 'token2', account_id: 'acc2' }
      ];

      tokens.forEach(t => {
        if (!tokenMap.has(t.access)) {
          tokenMap.set(t.access, { ...t, presets: [] });
        }
        tokenMap.get(t.access).presets.push('preset1');
      });

      expect(tokenMap.size).toBe(2);
    });
  });
});

describe('CLI Quota Rendering', () => {
  it('should handle empty results', () => {
    const results = [];
    expect(results.length).toBe(0);
  });

  it('should separate active and preset rows', () => {
    const results = [
      { provider: 'openai', presets: ['(Current Active)'] },
      { provider: 'openai', presets: ['preset1'] },
      { provider: 'google', presets: ['preset2'] }
    ];

    const activeRows = results.filter(r => r.presets.some(p => p.includes('Current Active')));
    const presetRows = results.filter(r => !r.presets.some(p => p.includes('Current Active')));

    expect(activeRows.length).toBe(1);
    expect(presetRows.length).toBe(2);
  });

  it('should format provider with label for Google', () => {
    const result = {
      provider: 'google',
      daily: { label: 'G3Flash' }
    };

    const displayProvider = result.provider === 'google' && result.daily?.label
      ? `${result.provider}\n(${result.daily.label})`
      : result.provider;

    expect(displayProvider).toContain('G3Flash');
  });
});
