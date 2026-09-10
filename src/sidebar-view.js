import { createHash } from 'node:crypto';
import stringWidth from 'string-width';
import { formatGiB } from './system-metrics.js';

export function compactReset(resetAt, now = Date.now()) {
  if (!Number.isFinite(resetAt) || resetAt <= 0) return '-';
  const milliseconds = resetAt - now;
  if (milliseconds <= 0) return 'reset';
  const minutes = Math.floor(milliseconds / 60_000);
  if (!minutes) return '<1m';
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
  return `${minutes}m`;
}

export function formatHerdrQuota(row, now = Date.now()) {
  const label = (row.provider === 'codex' ? 'CX' : 'CC') + (row.status === 'cached' ? '*' : '');
  const statuses = { missing: 'login', expired: 'expired', unauthorized: 'auth', rate_limited: '429', loading: '…', error: 'error' };
  if (!['ok', 'cached'].includes(row.status) || !Number.isFinite(row.percent)) return `${label} ${statuses[row.status] || 'error'}`;
  const percent = Math.round(Math.max(0, Math.min(100, row.percent)));
  const filled = Math.round(percent / 25);
  const window = ['7d', '24h', 'quota'].includes(row.window) ? ` ${row.window}` : '';
  return `${label}${window} ${'▰'.repeat(filled)}${'▱'.repeat(4 - filled)} ${percent}% ${compactReset(row.resetAt, now)}`;
}

export function warningLevel(percent, remaining = false, enabled = true) {
  if (!enabled || !Number.isFinite(percent)) return 'normal';
  const used = remaining ? 100 - percent : percent;
  return used >= 90 ? 'critical' : used >= 80 ? 'warning' : 'normal';
}

export function formatGoQuota(result) {
  if (result === undefined) return { value: '…', percent: null };
  if (result === null) return { value: 'N/A', percent: null };
  if (result.error) return { value: 'error', percent: null };
  const remaining = value => typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(100, value))) : null;
  const fiveHour = remaining(result.daily?.percent_remaining);
  const monthly = remaining(result.monthly_percent);
  const values = [fiveHour, monthly].filter(value => value !== null);
  if (!values.length) return { value: 'N/A', percent: null };
  const window = (label, percent) => {
    if (percent === null) return `${label}N/A`;
    const filled = Math.round(percent / 50);
    return `${label}${'▰'.repeat(filled)}${'▱'.repeat(2 - filled)}${percent}%`;
  };
  return { value: `${window('5h', fiveHour)} ${window('M', monthly)}`, percent: Math.min(...values) };
}

const colors = { cx: '#10A37F', cc: '#D87555', go: '#4890CD', disk: '#4890CD', ram: '#4890CD', gpu: '#4890CD', more: '#A89984' };
const key = (id, part) => `opm_metric_${id}_${part}`;

function viewRow({ id, label, value, percent = null, remaining = false, color, showBar = true }, warnings) {
  const tone = warningLevel(percent, remaining, warnings);
  const width = Math.max(1, Math.min(4, 22 - stringWidth(`${label} ${value}`) - 1));
  const filled = Number.isFinite(percent) ? Math.round(Math.max(0, Math.min(100, percent)) / 100 * width) : null;
  const bar = !showBar || filled === null ? '' : '▰'.repeat(filled) + '▱'.repeat(width - filled);
  const text = [label, bar, value].filter(Boolean).join(' ');
  return { id,
    config: [
      { token: '$' + key(id, 'label'), fg: color },
      { token: '$' + key(id, 'warning'), fg: '#FABD2F' },
      { token: '$' + key(id, 'critical'), fg: '#FB4934' },
    ],
    // Exactly one full-row token is visible: Herdr cannot insert its fixed " · "
    // separator. Warning colors therefore apply to the whole row.
    tokens: { [key(id, 'label')]: tone === 'normal' ? text : '',
      ...Object.fromEntries(['warning', 'critical'].map(level => [key(id, level), tone === level ? text : ''])) },
  };
}

export function buildSidebarView(settings, quota, metrics, now = Date.now(), budget = 14, goResult) {
  const items = [];
  const legacy = {};
  for (const [provider, id] of [['codex', 'cx'], ['claude', 'cc']]) {
    if (!settings[provider]) continue;
    const row = quota.find(row => row.provider === provider) || { provider, status: 'loading' };
    const full = formatHerdrQuota(row, now);
    legacy[`opm_${id}`] = full;
    const ok = ['ok', 'cached'].includes(row.status) && Number.isFinite(row.percent);
    const label = (id === 'cx' ? 'CX' : 'CC') + (row.status === 'cached' ? '*' : '');
    const window = ok && ['7d', '24h', 'quota'].includes(row.window) ? ` ${row.window}` : '';
    items.push({ id, label: label + window, color: colors[id], remaining: true, percent: ok ? row.percent : null,
      value: ok ? `${Math.round(row.percent)}% ${compactReset(row.resetAt, now)}` : full.slice(label.length).trim() });
  }
  if (settings.go) items.push({ id: 'go', label: goResult?.cached ? 'Go*' : 'Go', color: colors.go, remaining: true, showBar: false, ...formatGoQuota(goResult) });
  const metric = (id, label, row, color) => items.push({ id, label, color,
    percent: row?.status === 'ok' ? row.percent : null,
    value: row?.status === 'ok' ? `${row.approximate ? '~' : ''}${formatGiB(row.used)}/${formatGiB(row.total)}G` : row?.status === 'loading' ? '…' : 'N/A' });
  if (settings.disk) {
    const disks = metrics.disks.filter(row => settings.diskPaths.includes(row.path));
    for (const [i, row] of (disks.length ? disks : settings.diskPaths.map(path => ({ path, status: 'loading' }))).entries()) {
      const label = row.path.length > 10 ? row.path.slice(0, 9) + '…' : row.path;
      metric(`disk_${i}`, `Disk ${label}`, row, colors.disk);
    }
  }
  if (settings.ram) metric('ram', 'RAM', metrics.ram || { status: 'loading' }, colors.ram);
  if (settings.gpu && (settings.gpuIds === null || settings.gpuIds.length)) {
    for (const row of metrics.gpus.filter(row => settings.gpuIds === null || settings.gpuIds.includes(row.uuid))) {
      const id = createHash('sha256').update(row.uuid).digest('hex').slice(0, 8);
      metric(`gpu_${id}`, row.index == null ? 'GPU?' : `GPU${row.index}`, row, colors.gpu);
    }
    if (!metrics.gpus.length && metrics.gpuStatus === 'error') metric('gpu_error', 'GPU', null, colors.gpu);
  }
  const limit = Math.max(0, budget);
  let visible = items;
  if (items.length > limit && limit > 0) {
    const hidden = items.slice(limit - 1);
    const gpuCount = hidden.filter(item => item.id.startsWith('gpu_')).length;
    visible = [...items.slice(0, limit - 1), { id: 'more', label: `+${hidden.length} items`,
      value: gpuCount ? `${gpuCount} GPUs` : 'opm settings', color: colors.more }];
  } else if (!limit) visible = [];
  const rows = visible.map(item => viewRow(item, settings.warnings));
  return { rows: rows.map(row => row.config), tokens: { ...legacy, ...Object.assign({}, ...rows.map(row => row.tokens)) },
    overflow: Math.max(0, items.length - limit) };
}
