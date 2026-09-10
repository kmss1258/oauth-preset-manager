import { queryQuota, retryUntil } from './quota-cache.js';

function cleanUsage(usage) {
  const window = value => {
    if (value == null) return null;
    if (typeof value.percent_remaining !== 'number' || !Number.isFinite(value.percent_remaining)
      || value.percent_remaining < 0 || value.percent_remaining > 100) throw new Error('Invalid cached quota');
    return {
      label: typeof value.label === 'string' ? value.label.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 40) : '',
      percent_remaining: value.percent_remaining,
      reset_time_iso: typeof value.reset_time_iso === 'string' && Number.isFinite(Date.parse(value.reset_time_iso))
        ? new Date(value.reset_time_iso).toISOString() : null,
    };
  };
  if (!usage || !Array.isArray(usage.extra_windows) || usage.extra_windows.length > 32) throw new Error('Invalid cached quota');
  const result = { daily: window(usage.daily), weekly: window(usage.weekly), extra_windows: usage.extra_windows.map(window).filter(Boolean) };
  if (!result.daily && !result.weekly && !result.extra_windows.length) throw new Error('Empty cached quota');
  return result;
}

export function claudeRetryUntil(retryAfter, now) {
  return retryUntil(retryAfter, now);
}

export async function queryClaudeQuota({ token, directory, memory, fetchUsage, now = Date.now, blockedUntil = 0,
  classifyError }) {
  return queryQuota({
    directory,
    memory,
    namespace: 'claude-oauth-usage-v1',
    identity: { provider: 'claude', endpoint: 'https://api.anthropic.com/api/oauth/usage', schema: 1, credential: token },
    // Keep the established Claude filename scheme so existing snapshots survive the refactor.
    cacheKey: token,
    fetchUsage,
    normalize: usage => {
      const clean = cleanUsage(usage);
      for (const window of [clean.daily, clean.weekly, ...clean.extra_windows]) {
        if (window) window.label = window.label.split(token).join('[redacted]');
      }
      return clean;
    },
    now,
    blockedUntil,
    ...(typeof classifyError === 'function' ? { classifyError } : {}),
  });
}
