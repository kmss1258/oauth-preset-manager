#!/usr/bin/env node

import { select, input, confirm, checkbox, Separator } from '@inquirer/prompts';
import chalk from 'chalk';
import Table from 'cli-table3';
import { existsSync, promises as fs } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { StringDecoder } from 'node:string_decoder';
import { PresetManager, timeUntilReset } from './core.js';
import { t } from './i18n.js';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../package.json');
const stringWidth = require('string-width');
const stripAnsi = require('strip-ansi');
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const sgrPattern = `${String.fromCharCode(27)}\\[[0-9;]*m`;

// Keep SGR colors, but never let account/error text move the terminal cursor.
export function fitQuotaLine(text, width) {
  const clean = String(text).split(new RegExp(`(${sgrPattern})`, 'g')).map(part =>
    new RegExp(`^${sgrPattern}$`).test(part) ? part : Array.from(stripAnsi(part), char => {
      const code = char.codePointAt(0);
      return code < 32 || (code >= 127 && code <= 159) ? ' ' : char;
    }).join('')).join('');
  const plain = stripAnsi(clean);
  const limit = Math.max(0, width);
  if (stringWidth(plain) <= limit) return clean;
  if (limit === 0) return '';
  let result = '';
  let used = 0;
  for (const part of clean.split(new RegExp(`(${sgrPattern})`, 'g'))) {
    if (new RegExp(`^${sgrPattern}$`).test(part)) { result += part; continue; }
    for (const { segment } of graphemes.segment(part)) {
      const size = stringWidth(segment);
      if (used + size > limit - 1) return result + '…' + (clean.includes('\x1b') ? '\x1b[0m' : '');
      result += segment;
      used += size;
    }
  }
  return result;
}

function gradientCyan(text) {
  return chalk.cyan.bold(text);
}

function gradientHeader(text) {
  return chalk.bold.cyan(text);
}

const BOX = {
  h: '─',
  v: '│',
  tl: '┌',
  tr: '┐',
  bl: '└',
  br: '┘',
  cross: '┼',
  t: '┬',
  b: '┴',
};

export const QUOTA_FOOTER_TEXT = '  [r] Refresh  [g] Toggle Google details  [q] Exit';
export const QUOTA_REFRESH_INTERVAL_MS = 60_000;

const UTC_DAY_SECONDS = 24 * 60 * 60;
export const PEAK_WINDOWS = [
  { start: 1 * 60 * 60, end: 4 * 60 * 60 },
  { start: 6 * 60 * 60, end: 10 * 60 * 60 },
];
const PEAK_BORDER_COLORS = [
  [255, 179, 186],
  [255, 223, 186],
  [255, 255, 186],
  [186, 255, 201],
  [186, 225, 255],
  [218, 186, 255],
];

function epochSeconds(value) {
  const milliseconds = value instanceof Date ? value.getTime() : value;
  return Math.floor(milliseconds / 1000);
}

export function getPeakState(value = Date.now()) {
  const seconds = epochSeconds(value);
  const date = new Date(seconds * 1000);
  const daySecond = ((seconds % UTC_DAY_SECONDS) + UTC_DAY_SECONDS) % UTC_DAY_SECONDS;
  const weekday = date.getUTCDay();
  const isWeekday = day => day >= 1 && day <= 5;
  const activeWindow = isWeekday(weekday)
    ? PEAK_WINDOWS.find(window => daySecond >= window.start && daySecond < window.end)
    : null;
  if (activeWindow) {
    return { phase: 'active', secondsRemaining: activeWindow.end - daySecond, window: activeWindow };
  }

  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const candidateWeekday = (weekday + dayOffset) % 7;
    if (!isWeekday(candidateWeekday)) continue;
    for (const window of PEAK_WINDOWS) {
      const secondsUntil = dayOffset * UTC_DAY_SECONDS + window.start - daySecond;
      if (secondsUntil > 0 && secondsUntil <= 60 * 60) {
        return { phase: 'pre-alert', secondsRemaining: secondsUntil, window };
      }
    }
  }

  return { phase: 'off', secondsRemaining: null, window: null };
}

export function formatPeakCountdown(seconds) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return [hours, minutes, remainingSeconds].map(value => String(value).padStart(2, '0')).join(':');
}

export function formatPeakStatus(state) {
  if (state.phase === 'active') {
    return t('quota_peak_active', { duration: formatPeakCountdown(state.secondsRemaining) });
  }
  if (state.phase === 'pre-alert') {
    return t('quota_peak_pre_alert', { duration: formatPeakCountdown(state.secondsRemaining) });
  }
  return t('quota_peak_off');
}

function colorizePeakStatus(state, text) {
  if (state.phase === 'active') return chalk.red(text);
  if (state.phase === 'pre-alert') return chalk.yellow(text);
  return chalk.green(text);
}

function shouldRenderPeakBorder(output, interactive) {
  return Boolean(interactive === true && output?.isTTY && !process.env.NO_COLOR && !process.env.CI);
}

function peakBorder(text, epoch) {
  const [r, g, b] = PEAK_BORDER_COLORS[epoch % PEAK_BORDER_COLORS.length];
  const color = `\x1b[38;2;${r};${g};${b}m`;
  return `${color}│\x1b[39m${text}${color}│\x1b[39m`;
}

export function getQuotaRefreshCountdownSeconds(deadline, now = Date.now()) {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function formatQuotaRefreshCountdown(seconds) {
  return t('quota_auto_refresh_countdown', { seconds });
}

export async function getRootDiskLine(statfs = fs.statfs) {
  if (typeof statfs !== 'function') return null;

  try {
    const stats = await statfs('/', { bigint: true });
    const availableGiB = Number(stats.bavail * stats.bsize) / 1024 ** 3;
    return `💾 / ${availableGiB.toFixed(1)} GiB`;
  } catch {
    return null;
  }
}

export function formatQuotaCountdownLine(seconds, now = new Date(), peakState = getPeakState(now), options = {}) {
  const kstFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const time = kstFormatter.format(now);
  const kstHour = Number(kstFormatter.formatToParts(now).find(part => part.type === 'hour')?.value);
  const icon = kstHour >= 6 && kstHour < 18 ? '☀️' : '🌙';

  const refreshSegment = seconds == null
    ? ''
    : ` ${chalk.gray('·')} ${chalk.yellow(formatQuotaRefreshCountdown(seconds))}`;
  let line = `  ${chalk.cyan(t('quota_current_time', { time, icon }))} ${chalk.gray('·')} ${colorizePeakStatus(peakState, formatPeakStatus(peakState))}${refreshSegment}`;
  const width = options.width ?? (options.output?.columns ? options.output.columns - 1 : Infinity);
  if (stringWidth(line) > width) {
    const refresh = seconds == null ? '' : formatQuotaRefreshCountdown(seconds);
    line = [refresh, `${time} KST`, formatPeakStatus(peakState)].filter(Boolean).join(' · ');
    if (stringWidth(refresh) > width) line = seconds == null ? time : `↻ ${seconds}s`;
  }
  const bordered = peakState.phase === 'active' && shouldRenderPeakBorder(options.output, options.interactive)
    ? peakBorder(line, epochSeconds(now))
    : line;
  return fitQuotaLine(bordered, width);
}

export function updateQuotaCountdownLine(seconds, output = process.stdout, now = new Date()) {
  output.write(`\u001b[2;1H\u001b[2K${formatQuotaCountdownLine(seconds, now, getPeakState(now), { output, interactive: true })}`);
}

export function normalizeQuotaActionKey(text) {
  if (typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (trimmed === 'ㄱ') {
    return 'r';
  }

  const key = trimmed.toLowerCase();
  if (key === 'r' || key === 'g' || key === 'q') {
    return key;
  }

  return null;
}

export function buildInteractiveChoices(presets) {
  return [
    ...presets.map((p, i) => ({
      name: `  ${chalk.cyan(i + 1 + '.')} ${p.is_current ? chalk.green('●') : chalk.gray('○')} ${p.name}${formatPresetChoiceQuotaSuffix(p)}`,
      value: p.name,
      description: p.description || chalk.gray('No description')
    })),
    new Separator(chalk.gray('  ' + BOX.h.repeat(48))),
    {
      name: `  ${chalk.green('💾')} ${t('save_new_preset')}`,
      value: '__save__',
      description: 'Save current auth as new preset'
    },
    {
      name: `  ${chalk.blue('📝')} ${t('view_description')}`,
      value: '__view__',
      description: 'View preset details'
    },
    {
      name: `  ${chalk.magenta('📊')} ${t('view_quota')}`,
      value: '__quota__',
      description: 'Check quota usage'
    },
    {
      name: `  ${chalk.yellow('🧠')} ${t('openai_quota_kickoff')}`,
      value: '__openai_kickoff__',
      description: 'Send one GPT-5.6 Luna request to each OpenAI target'
    },
    {
      name: `  ${chalk.cyan('🔗')} ${t('distribute_credentials')}`,
      value: '__distribute_credentials__',
      description: 'Select credentials, then destination presets'
    },
    {
      name: `  ${chalk.yellow('🗑️')} ${t('delete_preset')}`,
      value: '__delete__',
      description: 'Delete a preset'
    },
    new Separator(),
    {
      name: `  ${chalk.red('❌')} ${t('exit')}`,
      value: '__exit__',
      description: 'Exit OPM'
    },
  ];
}

function printHeader() {
  console.clear();
  console.log();
  console.log(chalk.cyan.bold('    ██████╗ ██████╗ ███╗   ███╗'));
  console.log(chalk.cyan.bold('   ██╔═══██╗██╔══██╗████╗ ████║'));
  console.log(chalk.blue.bold('   ██║   ██║██████╔╝██╔████╔██║'));
  console.log(chalk.blue.bold('   ██║   ██║██╔═══╝ ██║╚██╔╝██║'));
  console.log(chalk.magenta.bold('   ╚██████╔╝██║     ██║ ╚═╝ ██║'));
  console.log(chalk.magenta.bold('    ╚═════╝ ╚═╝     ╚═╝     ╚═╝'));
  console.log();
  console.log(chalk.dim('   OAuth Preset Manager ') + chalk.yellow(`v${APP_VERSION}`) + chalk.dim(' - Node.js Edition'));
  console.log();
  console.log(chalk.gray('   ' + BOX.h.repeat(50)));
  console.log();
}

function printInfoBox(title, items) {
  const maxLen = Math.max(title.length, ...items.map(i => i.length)) + 4;
  const width = Math.min(maxLen, 60);
  
  console.log(chalk.cyan(`${BOX.tl}${BOX.h.repeat(width - 2)}${BOX.tr}`));
  console.log(chalk.cyan(`${BOX.v} `) + chalk.bold.white(title.padEnd(width - 4)) + chalk.cyan(` ${BOX.v}`));
  console.log(chalk.cyan(`${BOX.v}${' '.repeat(width - 2)}${BOX.v}`));
  
  for (const item of items) {
    const truncated = item.length > width - 4 ? item.slice(0, width - 7) + '...' : item;
    console.log(chalk.cyan(`${BOX.v} `) + truncated.padEnd(width - 4) + chalk.cyan(` ${BOX.v}`));
  }
  
  console.log(chalk.cyan(`${BOX.bl}${BOX.h.repeat(width - 2)}${BOX.br}`));
  console.log();
}

function printPresetCard(preset, index, isActive, isCurrent) {
  const icon = isActive ? chalk.green('●') : chalk.gray('○');
  const name = isCurrent ? chalk.cyan.bold(preset.name) : chalk.white(preset.name);
  const status = isCurrent 
    ? chalk.green(' [ACTIVE]') 
    : isActive 
      ? chalk.yellow(' [CURRENT]') 
      : '';
  
  const services = preset.services?.slice(0, 3).join(', ') || '-';
  const desc = preset.description 
    ? chalk.dim(` │ ${preset.description.slice(0, 30)}`) 
    : '';
  
  console.log(`  ${icon} ${index + 1}. ${name}${status}`);
  if (desc) console.log(`     ${desc}`);
  console.log(`     ${chalk.dim('Services:')} ${chalk.blue(services)} ${chalk.dim('│ Last used:')} ${chalk.yellow(preset.last_used || 'Never')}`);
  const quotaSummary = buildPresetQuotaSummary(preset);
  if (quotaSummary) {
    const color = quotaSummary.tone === 'error'
      ? chalk.red
      : quotaSummary.tone === 'warn'
        ? chalk.yellow
        : chalk.cyan;
    console.log(`     ${chalk.dim('Quota:')} ${color(quotaSummary.text)}`);
  }
  console.log();
}

function truncateText(value, maxLength) {
  if (typeof value !== 'string') return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatRelativeAge(isoString, now = new Date()) {
  if (!isoString) return null;

  const target = new Date(isoString);
  if (Number.isNaN(target.getTime())) return null;

  const diffMs = Math.max(0, now.getTime() - target.getTime());
  const totalMinutes = Math.floor(diffMs / 60000);

  if (totalMinutes < 1) return 'just now';
  if (totalMinutes < 60) return `${totalMinutes}m ago`;

  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ago`;

  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d ago`;
}

function colorizeQuotaValue(value, label) {
  if (value == null) {
    return chalk.gray(`${label}-`);
  }

  let color = chalk.green;
  if (value < 20) color = chalk.red;
  else if (value < 50) color = chalk.yellow;

  return `${chalk.dim(label)}${color(`${value}%`)}`;
}

export function buildPresetQuotaSummary(preset, now = new Date()) {
  const snapshot = preset?.quota_snapshot;
  if (!snapshot || snapshot.provider !== 'openai') {
    return null;
  }

  const daily = snapshot.daily_percent == null ? '-' : `${snapshot.daily_percent}%`;
  const weekly = snapshot.weekly_percent == null ? '-' : `${snapshot.weekly_percent}%`;
  const dailyDisplay = colorizeQuotaValue(snapshot.daily_percent, 'D');
  const weeklyDisplay = colorizeQuotaValue(snapshot.weekly_percent, 'W');
  const lastSuccessAge = formatRelativeAge(snapshot.last_success_at, now);
  const errorText = truncateText(snapshot.last_error || '', 28);

  if (snapshot.last_error) {
    if (snapshot.last_success_at) {
      const ageSuffix = lastSuccessAge ? ` · ${lastSuccessAge}` : '';
      const errorSuffix = errorText ? ` · ${errorText}` : '';
      return {
        text: `OAI ${dailyDisplay} ${weeklyDisplay} · stale${ageSuffix}${errorSuffix}`,
        plainText: `OAI D${daily} W${weekly} · stale${ageSuffix}${errorSuffix}`,
        tone: 'warn',
      };
    }

    return {
      text: errorText ? `OAI fetch failed · ${errorText}` : 'OAI fetch failed',
      plainText: errorText ? `OAI fetch failed · ${errorText}` : 'OAI fetch failed',
      tone: 'error',
    };
  }

  const ageSuffix = lastSuccessAge ? ` · ${lastSuccessAge}` : '';
  return {
    text: `OAI ${dailyDisplay} ${weeklyDisplay}${ageSuffix}`,
    plainText: `OAI D${daily} W${weekly}${ageSuffix}`,
    tone: 'info',
  };
}

function formatPresetChoiceQuotaSuffix(preset) {
  const summary = buildPresetQuotaSummary(preset);
  if (!summary) {
    return '';
  }

  if (!summary.plainText || summary.plainText.length <= 30) {
    return chalk.dim('  ·  ') + summary.text;
  }

  const compact = truncateText(summary.plainText, 30);
  return chalk.dim(`  ·  ${compact}`);
}

function printMenuSection() {
  console.log();
  console.log(chalk.gray('  ' + BOX.h.repeat(48)));
  console.log(chalk.cyan.bold('  ⚡ ACTIONS'));
  console.log(chalk.gray('  ' + BOX.h.repeat(48)));
  console.log();
}

function enableEscToExit() {
  if (!process.stdin.isTTY) return () => {};
  const wasRawMode = process.stdin.isRaw;
  const wasPaused = process.stdin.isPaused() || process.stdin.readableFlowing === null;
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);
  const onKeypress = (_str, key) => {
    if (key?.name === 'escape') {
      console.log();
      process.exit(0);
    }
  };
  process.stdin.on('keypress', onKeypress);
  return () => {
    process.stdin.off('keypress', onKeypress);
    if (process.stdin.setRawMode) process.stdin.setRawMode(Boolean(wasRawMode));
    if (wasPaused) process.stdin.pause();
  };
}

const PRO_PLAN_TYPES = new Set(['pro', 'prolite']);
const PRO_GRADIENT_STOPS = [
  { r: 56, g: 189, b: 248 },
  { r: 45, g: 212, b: 191 },
  { r: 139, g: 92, b: 246 },
];

function normalizePlanType(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

export function isRainbowQuotaEligible(result) {
  return result?.provider === 'openai'
    && !result.error
    && result.plan_type_source === 'usage'
    && PRO_PLAN_TYPES.has(normalizePlanType(result.plan_type));
}

function blendColor(start, end, ratio) {
  return {
    r: Math.round(start.r + (end.r - start.r) * ratio),
    g: Math.round(start.g + (end.g - start.g) * ratio),
    b: Math.round(start.b + (end.b - start.b) * ratio),
  };
}

function gradientColorAt(index, total) {
  if (total <= 1) return PRO_GRADIENT_STOPS[0];

  const scaled = index / (total - 1) * (PRO_GRADIENT_STOPS.length - 1);
  const stopIndex = Math.min(PRO_GRADIENT_STOPS.length - 2, Math.floor(scaled));
  return blendColor(
    PRO_GRADIENT_STOPS[stopIndex],
    PRO_GRADIENT_STOPS[stopIndex + 1],
    scaled - stopIndex,
  );
}

function proGradientBar(text) {
  return Array.from(text).map((char, index, chars) => {
    const { r, g, b } = gradientColorAt(index, chars.length);
    return `\x1b[38;2;${r};${g};${b}m${char}\x1b[39m`;
  }).join('');
}

function shouldRenderProGradient(value) {
  if (value === 'force') return true;
  if (!value || process.env.NO_COLOR || process.env.CI) return false;
  return Boolean(process.stdout.isTTY);
}

const OPENCODE_GO_PERCENT_OPTIONS = { fillColor: chalk.cyan };
const COMMAND_CODE_PERCENT_OPTIONS = { fillColor: chalk.magenta };

function formatOpenCodeGoPercent(value) {
  return formatPercent(value, OPENCODE_GO_PERCENT_OPTIONS);
}

export function formatPercent(value, options = {}) {
  if (value == null) return chalk.gray('-');

  const width = Math.max(1, Math.min(40, options.width ?? 10));
  const filledLen = Math.max(0, Math.min(width, Math.round(value / 100 * width)));
  const emptyLen = width - filledLen;
  const filled = '█'.repeat(filledLen);

  const barFilled = shouldRenderProGradient(options.rainbow) && filled
    ? proGradientBar(filled)
    : (options.fillColor || chalk.green)(filled);
  const barEmpty = chalk.gray('░'.repeat(emptyLen));

  let color = chalk.green;
  if (value < 20) color = chalk.red;
  else if (value < 50) color = chalk.yellow;

  return `${barFilled}${barEmpty} ${color(value.toString().padStart(3) + '%')}`;
}

function formatPercentTwoLine(value) {
  if (value == null) return { bar: chalk.gray('-'), percent: chalk.gray('-') };

  const width = 10;
  const filledLen = Math.max(0, Math.min(width, Math.round(value / 100 * width)));
  const emptyLen = width - filledLen;

  const barFilled = chalk.green('█'.repeat(filledLen));
  const barEmpty = chalk.gray('░'.repeat(emptyLen));

  let color = chalk.green;
  if (value < 20) color = chalk.red;
  else if (value < 50) color = chalk.yellow;

  return {
    bar: `${barFilled}${barEmpty}`,
    percent: color((value.toString() + '%').padStart(width))
  };
}

function formatReset(value) {
  if (!value) return chalk.gray('-');
  const time = timeUntilReset(value);
  if (time === 'Resetting...') return chalk.yellow(time);
  return chalk.cyan(time);
}

function deduplicateResults(results) {
  const seen = new Map();
  
  for (const result of results) {
    const isCurrent = (result.presets || []).some(p => p.includes('Current Active'));
    const presetSignature = (result.presets || []).slice().sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).join('|') || '-';
    const key = `${result.provider}-${result.account_id}-${result.daily?.label || 'default'}-${isCurrent ? 'current' : 'preset'}-${presetSignature}`;
    const existing = seen.get(key);
    
    if (!existing) {
      seen.set(key, result);
    } else if (result.error && !existing.error) {
      existing.error = result.error;
    }
  }
  
  return Array.from(seen.values());
}

function extractPresetName(label) {
  if (!label || label.startsWith('(')) return null;
  const idx = label.indexOf(' (');
  if (idx > 0) return label.slice(0, idx);
  return label;
}

function getPresetSortKey(result) {
  const names = (result.presets || [])
    .map(extractPresetName)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  if (names.length > 0) return names[0];
  return null;
}

function hasPresetLabel(result, label) {
  return (result.presets || []).some(p => p.includes(label));
}

function sortResultsByPresetName(results) {
  const providerOrder = { openai: 0, opencodego: 1, commandcode: 2, claude: 3, google: 4 };
  const entries = results.map((r, i) => ({
    r,
    i,
    key: getPresetSortKey(r),
    isCurrent: hasPresetLabel(r, 'Current Active'),
    isAntigravity: hasPresetLabel(r, 'Antigravity'),
  }));

  entries.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.isAntigravity !== b.isAntigravity) return a.isAntigravity ? -1 : 1;

    const aHas = Boolean(a.key);
    const bHas = Boolean(b.key);
    if (aHas && bHas) {
      const cmp = a.key.localeCompare(b.key, undefined, { sensitivity: 'base' });
      if (cmp !== 0) return cmp;
    } else if (aHas) {
      return -1;
    } else if (bHas) {
      return 1;
    }

    const providerCmp = (providerOrder[a.r.provider] ?? 99) - (providerOrder[b.r.provider] ?? 99);
    if (providerCmp !== 0) return providerCmp;

    const accountCmp = (a.r.account_id || '').localeCompare(b.r.account_id || '');
    if (accountCmp !== 0) return accountCmp;

    return a.i - b.i;
  });

  return entries.map(entry => entry.r);
}

export function normalizeQuotaResults(results) {
  return sortResultsByPresetName(deduplicateResults(results));
}

export function getQuotaTableRowItems(normalizedResults, showGoogle = true) {
  return showGoogle ? normalizedResults : normalizedResults.filter(r => r.provider !== 'google');
}

export function summarizeOpenAIRefreshResults(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const succeeded = results.filter(result => result.success).length;
  return {
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
  };
}

function formatAccountLabel(result) {
  const accountId = result?.account_id || '';
  const nickname = result?.nickname;
  if (nickname && accountId) return `${nickname} (${accountId})`;
  return nickname || accountId || '-';
}

export function formatOpenCodeGoAccountCell(result, options = {}) {
  const accountId = result?.account_id || '-';
  const lines = [chalk.yellow(accountId)];
  if (options.includeWeekly) {
    lines.push(`${chalk.dim('W ')}${formatOpenCodeGoPercent(result?.weekly?.percent_remaining)} ${chalk.dim('·')} ${formatReset(result?.weekly?.reset_time_iso)}`);
  }
  lines.push(`${chalk.dim('M ')}${formatOpenCodeGoPercent(result?.monthly_percent)} ${chalk.dim('·')} ${formatReset(result?.monthly_reset_iso)}`);
  return lines.join('\n');
}

export function formatCommandCodeAccountCell(result) {
  const account = chalk.cyan(result?.nickname || result?.account_id || '-');
  const tokens = result?.command_code_usage?.total_tokens;
  return tokens ? `${account}\n${chalk.dim(`${tokens.toLocaleString('en-US')} tokens`)}` : account;
}

export function formatCommandCodeQuotaCell(result, window, detail = '') {
  const value = formatPercent(window?.percent_remaining, COMMAND_CODE_PERCENT_OPTIONS);
  return detail ? `${value}\n${chalk.dim(detail)}` : value;
}

function getCommandCodeDailyDetail(result) {
  const total = result?.command_code_credits?.total_remaining;
  return total == null ? '' : `$${total.toFixed(2)} credits`;
}

function getCommandCodeWeeklyDetail(result) {
  const requests = result?.command_code_usage?.total_count;
  return requests ? `${requests.toLocaleString('en-US')} requests` : '';
}

function formatCommandCodeProvider() {
  return chalk.yellow('Command Code');
}

export function formatCommandCodeResetCell(result, window) {
  const lines = [formatReset(window?.reset_time_iso)];
  const totalCost = result?.command_code_usage?.total_cost;
  if (totalCost != null) lines.push(chalk.dim(`$${totalCost.toFixed(2)} used`));
  return lines.join('\n');
}

function getTerminalWidth() {
  return process.stdout.columns || 80;
}

function printSwitchResult(result) {
  console.log();
  console.log(chalk.green.bold('  ✓ SUCCESS'));
  console.log(chalk.cyan(`  ${BOX.v} `) + `${t('switched_to')}: ${chalk.bold.white(result.preset_name)}`);
  
  if (result.backup_path) {
    console.log(chalk.cyan(`  ${BOX.v} `) + chalk.dim(`📦 Backup: ${result.backup_path.replace(homedir(), '~')}`));
  }

  const diff = result.diff || {};
  if (diff.added?.length || diff.removed?.length || diff.modified?.length) {
    console.log();
    console.log(chalk.yellow('  🔄 Changes:'));
    if (diff.added?.length) {
      console.log(chalk.green(`     + ${t('added')}:`) + ` ${diff.added.join(', ')}`);
    }
    if (diff.removed?.length) {
      console.log(chalk.red(`     - ${t('removed')}:`) + ` ${diff.removed.join(', ')}`);
    }
    if (diff.modified?.length) {
      console.log(chalk.yellow(`     ~ ${t('modified')}:`) + ` ${diff.modified.join(', ')}`);
    }
  } else {
    console.log(chalk.dim(`  ${t('no_changes_detected')}`));
  }
  console.log();
}

async function setupAuthPath(manager) {
  printHeader();
  const defaultPath = manager.getSuggestedAuthPath();

  if (existsSync(defaultPath)) {
    printInfoBox('🔐 Auth Configuration', [
      chalk.green('✓ Found:') + ` ${defaultPath.replace(homedir(), '~')}`,
    ]);
    await manager.setAuthPath(defaultPath);
    await input({ message: chalk.dim('Press Enter to continue...') });
    return true;
  }

  console.log(chalk.yellow('  ⚠ ' + t('auth_not_found')));
  console.log();

  const customPath = await input({
    message: chalk.cyan('  📁 ' + t('enter_auth_path')),
    default: defaultPath,
  });

  if (customPath && existsSync(customPath)) {
    await manager.setAuthPath(customPath);
    printInfoBox('✓ Success', [t('auth_path_set')]);
    return true;
  }

  console.log(chalk.red(`  ✗ ${t('invalid_path')}`));
  return false;
}

async function viewDescriptionInteractive(manager, presets) {
  console.clear();
  printHeader();
  
  console.log(chalk.bold.cyan('  📝 Preset Details\n'));
  
  const table = new Table({
    head: [
      chalk.cyan.bold('#'),
      chalk.cyan.bold(t('preset')),
      chalk.cyan.bold(t('description')),
      chalk.cyan.bold(t('watched')),
      chalk.cyan.bold(t('last_used')),
    ],
    style: { border: ['gray'] },
    colWidths: [4, 20, 30, 15, 20],
    wordWrap: true,
  });

  for (let i = 0; i < presets.length; i++) {
    const p = presets[i];
    const info = await manager.getPresetInfo(p.name);
    const meta = info?.metadata || {};
    const watched = (meta.watched_services || ['openai']).join(', ');
    const marker = p.is_current ? chalk.green('★') : chalk.gray(' ');
    
    table.push([
      `${marker} ${i + 1}`,
      p.name,
      meta.description || chalk.gray('-'),
      chalk.blue(watched),
      chalk.yellow(p.last_used || 'Never'),
    ]);
  }

  console.log(table.toString());
  console.log();
  await input({ message: chalk.dim('Press Enter to continue...') });
}

async function savePresetInteractive(manager) {
  console.clear();
  printHeader();
  
  const authPath = manager.getAuthPath();
  if (!existsSync(authPath)) {
    console.log(chalk.red(`  ✗ ${t('auth_file_not_found')}`));
    return;
  }

  console.log(chalk.bold.cyan('  💾 Save New Preset\n'));
  
  const name = await input({
    message: chalk.cyan('  📝 ' + t('enter_preset_name')),
    validate: (text) => text?.length > 0 || t('name_required'),
  });

  if (!name) return;

  const description = await input({ 
    message: chalk.cyan('  📄 ' + t('enter_description')) 
  });

  let availableServices = [];
  try {
    const data = JSON.parse(await (await import('fs')).promises.readFile(authPath, 'utf-8'));
    availableServices = Object.keys(data);
  } catch {}

  let watchedServices = ['openai'];
  if (availableServices.length > 0) {
    watchedServices = await checkbox({
      message: chalk.cyan('  👁 ' + t('watched_services_prompt')),
      choices: availableServices.map(s => ({ 
        name: s, 
        value: s, 
        checked: s === 'openai' 
      })),
    });
    if (!watchedServices?.length) watchedServices = ['openai'];
  }

  try {
    await manager.savePreset(name, description || '', watchedServices);
    console.log();
    printInfoBox('✓ Success', [`${t('saved_preset')}: ${name}`]);
  } catch (e) {
    console.log(chalk.red(`  ✗ ${t('error')}: ${e.message}`));
  }
}

async function deletePresetInteractive(manager, presets) {
  console.clear();
  printHeader();
  
  if (!presets.length) return;

  console.log(chalk.bold.yellow('  🗑️  Delete Preset\n'));
  
  const choices = presets.map((p, i) => ({ 
    name: `${i + 1}. ${p.name}${p.is_current ? chalk.green(' [active]') : ''}`, 
    value: p.name 
  }));
  
  const selection = await select({
    message: chalk.cyan('  ' + t('select_preset_to_delete')),
    choices,
  });

  if (!selection) return;

  console.log();
  const confirmed = await confirm({
    message: chalk.yellow('  ⚠️  ' + t('confirm_delete', { name: selection })),
    default: false,
  });

  if (confirmed) {
    try {
      await manager.deletePreset(selection);
      printInfoBox('✓ Success', [`${t('deleted_preset')}: ${selection}`]);
    } catch (e) {
      console.log(chalk.red(`  ✗ ${t('error')}: ${e.message}`));
    }
  }
}

export async function distributeCredentialsInteractive(manager, prompts = { checkbox, confirm }) {
  console.clear();
  printHeader();
  const source = manager.config?.current_preset;
  if (!source) {
    console.log(chalk.yellow(`  ⚠ ${t('oauth_propagate_no_current')}`));
    return;
  }

  const credentialOptions = await manager.getCurrentPresetCredentialOptions();
  if (credentialOptions.length === 0) {
    console.log(chalk.yellow(`  ⚠ ${t('credential_distribution_no_credentials')}`));
    return;
  }

  const selectedCredentials = await prompts.checkbox({
    message: chalk.cyan(`  ${t('credential_distribution_select_credentials')}`),
    choices: credentialOptions.map(option => ({
      name: option.label === 'OpenCode Go OAuth session'
        ? `${t('opencode_go_oauth_session')} (${t('opencode_go_session_description')})`
        : option.description ? `${option.label} (${option.description})` : option.label,
      value: option.authServiceKey || '__opencode_go_session__',
    })),
  });
  if (!selectedCredentials?.length) {
    console.log(chalk.yellow(`  ⚠ ${t('credential_distribution_no_selection')}`));
    return;
  }

  const includeOpenCodeGoSession = selectedCredentials.includes('__opencode_go_session__');
  const authServiceKeys = selectedCredentials.filter(value => value !== '__opencode_go_session__');
  const destinations = (await manager.listPresets())
    .map(preset => preset.name)
    .filter(name => name !== source);
  if (destinations.length === 0) {
    console.log(chalk.yellow(`  ⚠ ${t('credential_distribution_no_destinations')}`));
    return;
  }

  const selected = await prompts.checkbox({
    message: chalk.cyan(`  ${t('credential_distribution_select_targets')}`),
    choices: destinations.map(name => ({ name, value: name, checked: true })),
  });
  if (!selected?.length) {
    console.log(chalk.yellow(`  ⚠ ${t('credential_distribution_no_selection')}`));
    return;
  }

  const confirmed = await prompts.confirm({
    message: chalk.yellow(`  ${t('credential_distribution_confirm', {
      credentials: credentialOptions.filter(option => selectedCredentials.includes(option.authServiceKey || '__opencode_go_session__')).map(option => option.label).join(', '),
      source,
      targets: selected.join(', '),
    })}`),
    default: false,
  });
  if (!confirmed) return;

  try {
    const result = await manager.distributeCurrentPresetCredentials({ authServiceKeys, includeOpenCodeGoSession, targetNames: selected });
    const changed = result.changed.length;
    const unchanged = result.unchanged.length;
    printInfoBox('✓ Success', [
      t('credential_distribution_complete'),
      `${t('credential_distribution_changed')}: ${changed}`,
      `${t('credential_distribution_unchanged')}: ${unchanged}`,
    ]);
  } catch (error) {
    console.log(chalk.red(`  ✗ ${t('error')}: ${error.message}`));
  }
}

export const propagateOAuthInteractive = distributeCredentialsInteractive;

async function cmdSave(manager, name) {
  try {
    const authPath = manager.getAuthPath();
    if (!existsSync(authPath)) {
      console.log(chalk.red(`  ✗ ${t('auth_file_not_found')}: ${authPath}`));
      return;
    }

    await manager.savePreset(name);
    printInfoBox('✓ Success', [`${t('saved_preset')}: ${name}`]);
  } catch (e) {
    console.log(chalk.red(`  ✗ ${t('error')}: ${e.message}`));
  }
}

async function cmdSwitch(manager, name) {
  try {
    const result = await manager.switchPreset(name);
    printSwitchResult(result);
  } catch (e) {
    if (e.message.includes('not found')) {
      console.log(chalk.red(`  ✗ ${t('preset_not_found')}: ${name}`));
    } else {
      console.log(chalk.red(`  ✗ ${t('error')}: ${e.message}`));
    }
  }
}

export function waitForQuotaKeypress(timeoutMs = null) {
  if (!process.stdin.isTTY) return Promise.resolve('return');

  return new Promise(resolve => {
    const wasRawMode = process.stdin.isRaw;
    const wasPaused = process.stdin.isPaused() || process.stdin.readableFlowing === null;
    let timeoutHandle = null;
    let escapeHandle = null;
    let pending = '';
    const decoder = new StringDecoder('utf8');
    let settled = false;

    if (process.stdin.setRawMode && !wasRawMode) {
      process.stdin.setRawMode(true);
    }

    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdout.off('resize', onResize);
      clearTimeout(escapeHandle);
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (process.stdin.setRawMode && !wasRawMode) {
        process.stdin.setRawMode(false);
      }
      if (wasPaused) {
        process.stdin.pause();
      }
    };

    const finish = action => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(action);
    };

    const onData = (chunk) => {
      pending += decoder.write(chunk);
      if (pending.includes('\u0003')) return finish('q');
      const sequences = { '\u001b[B': 'next', '\u001b[6~': 'next', '\u001b[A': 'previous', '\u001b[5~': 'previous' };
      while (pending) {
        if (pending.startsWith('\u001b')) {
          const complete = Object.keys(sequences).find(sequence => pending.startsWith(sequence));
          if (complete) return finish(sequences[complete]);
          if (Object.keys(sequences).some(sequence => sequence.startsWith(pending))) {
            clearTimeout(escapeHandle);
            escapeHandle = setTimeout(() => finish(pending === '\u001b' ? 'escape' : 'timeout'), 150);
            return;
          }
        }
        const char = Array.from(pending)[0];
        pending = pending.slice(char.length);
        if (char === '\r' || char === '\n') return finish('return');
        if (char === 'j') return finish('next');
        if (char === 'k') return finish('previous');
        const key = normalizeQuotaActionKey(char);
        if (key) return finish(key);
      }
    };

    const onResize = () => finish('resize');
    process.stdout.on('resize', onResize);
    process.stdin.on('data', onData);
    process.stdin.resume();
    if (timeoutMs != null) {
      timeoutHandle = setTimeout(() => {
        if (pending || decoder.lastNeed) timeoutHandle = setTimeout(() => finish('timeout'), 150);
        else finish('timeout');
      }, Math.max(0, timeoutMs));
    }
  });
}

export function buildQuotaFrame(results, options = {}) {
  const { columns = 80, rows = 24, interactive = false, showGoogle = false,
    page = 0, seconds = null, now = new Date(), rootDiskLine = null, warning = null } = options;
  // Reserve the last column/row: writing the bottom-right cell can scroll a TTY.
  const width = Math.max(0, columns - 1);
  const body = [];
  const accountStarts = [];
  const items = getQuotaTableRowItems(normalizeQuotaResults(results), showGoogle);
  const account = result => {
    const label = result.provider === 'commandcode' ? formatCommandCodeAccountCell(result) : formatAccountLabel(result);
    const details = result.provider === 'commandcode' ? [getCommandCodeDailyDetail(result), getCommandCodeWeeklyDetail(result),
      result.command_code_usage?.total_cost == null ? '' : `$${result.command_code_usage.total_cost.toFixed(2)} used`] : [];
    return [label, ...(result.presets || []), ...details.filter(Boolean)].join('\n');
  };
  const windows = result => [
    [result.provider === 'claude' ? '5h' : 'D', result.daily],
    ['W', result.weekly],
    ...(result.provider === 'opencodego' ? [['M', { percent_remaining: result.monthly_percent, reset_time_iso: result.monthly_reset_iso }]] : []),
    ...(result.extra_windows || []).map(window => [window.label, window]),
  ];
  if (columns >= 100) {
    const accountWidth = width - 83;
    const table = new Table({
      head: [t('quota_provider'), t('quota_daily'), t('quota_daily_reset'), t('quota_weekly'), t('quota_weekly_reset'), t('quota_account')].map(text => chalk.cyan.bold(text)),
      colWidths: [14, 18, 12, 18, 12, width - 81],
      style: { head: [], border: ['gray'], compact: true }, wordWrap: true,
    });
    for (const result of items) {
      const percentOptions = result.provider === 'opencodego' ? OPENCODE_GO_PERCENT_OPTIONS
        : result.provider === 'commandcode' ? COMMAND_CODE_PERCENT_OPTIONS : { rainbow: isRainbowQuotaEligible(result) };
      const details = windows(result).slice(2).map(([label, window]) =>
        `${label}\n${formatPercent(window?.percent_remaining, { ...percentOptions, width: Math.min(10, accountWidth - 5) })}\n${formatReset(window?.reset_time_iso)}`);
      table.push([
        result.provider === 'google' ? `google ${result.daily?.label || ''}` : result.provider === 'claude' ? 'Claude (5h)' : result.provider,
        result.error ? chalk.red(result.error) : formatPercent(result.daily?.percent_remaining, percentOptions),
        formatReset(result.daily?.reset_time_iso), formatPercent(result.weekly?.percent_remaining, percentOptions),
        formatReset(result.weekly?.reset_time_iso), [account(result), ...details].join('\n').split('\n').map(line => fitQuotaLine(line, accountWidth)).join('\n'),
      ].map(cell => String(cell).split('\n').map(line => fitQuotaLine(line, Infinity)).join('\n')));
    }
    if (items.length) body.push(...table.toString().split('\n'));
  } else {
    for (const result of items) {
      accountStarts.push(body.length);
      const provider = { openai: 'OpenAI', claude: 'Claude', opencodego: 'OpenCode Go', commandcode: 'Command Code', google: 'Google' }[result.provider] || result.provider;
      body.push(chalk.cyan.bold(`● ${provider}${result.daily?.label ? ` · ${result.daily.label}` : ''}`));
      body.push(...account(result).split('\n').map(line => chalk.yellow(line)));
      if (result.error) body.push(chalk.red(result.error));
      else for (const [label, window] of windows(result)) {
        if (!window) continue;
        const shortLabel = fitQuotaLine(label, Math.max(2, Math.min(8, width - 9))).padEnd(2);
        const barWidth = Math.max(1, Math.min(14, width - stringWidth(shortLabel) - 7));
        const bar = formatPercent(window.percent_remaining, { width: barWidth,
          rainbow: isRainbowQuotaEligible(result),
          fillColor: result.provider === 'opencodego' ? chalk.cyan : result.provider === 'commandcode' ? chalk.magenta : chalk.green });
        const line = `${chalk.dim(shortLabel)} ${bar}`;
        const reset = formatReset(window.reset_time_iso);
        if (stringWidth(`${line} · ${reset}`) <= width) body.push(`${line} · ${reset}`);
        else body.push(line, `  ↻ ${reset}`);
      }
      body.push('');
    }
  }
  if (!items.length) body.push(t('quota_no_results'));
  const hidden = results.filter(result => result.provider === 'google').length;
  if (!showGoogle && hidden) body.push(`Google: ${hidden} [g]`);
  if (warning) body.unshift(chalk.red(warning));
  const refreshSummary = summarizeOpenAIRefreshResults(options.refreshResults);
  if (refreshSummary) {
    body.push(`${t('openai_refresh_title')}: ${refreshSummary.succeeded}/${refreshSummary.total}`);
    for (const result of options.refreshResults) {
      body.push((result.success ? chalk.green : chalk.red)(`${result.preset_name}: ${result.success ? t('openai_refresh_updated') : result.error || t('openai_refresh_failed')}`));
    }
  }
  while (body.at(-1) === '') body.pop();
  const header = [
    (warning ? chalk.yellow('! ') : '') + chalk.cyan.bold(width >= 65 ? `OPM · ${t('quota_title')}` : 'OPM') + (rootDiskLine ? `  ${rootDiskLine}` : ''),
    formatQuotaCountdownLine(seconds, now, getPeakState(now), { width, output: options.output, interactive }),
  ];
  if (!interactive) return { lines: [...header, ...body].map(line => fitQuotaLine(line, width)), page: 0, pages: 1 };
  const height = Math.max(0, rows - 1);
  if (height < 4) return { lines: [header[1], '[q]'].slice(0, height).map(line => fitQuotaLine(line, width)), page: 0, pages: 1 };
  const pageSize = height - header.length - 1;
  const boundaries = accountStarts.map(index => index > 0 && warning ? index + 1 : index);
  const chunks = [];
  for (let start = 0; start < body.length;) {
    let end = Math.min(body.length, start + pageSize);
    // Keep mobile account groups together whenever a whole group fits.
    if (end < body.length) end = boundaries.filter(index => index > start && index <= end).at(-1) ?? end;
    chunks.push(body.slice(start, end));
    start = end;
    while (body[start] === '') start++;
  }
  const pages = Math.max(1, chunks.length);
  const currentPage = Math.max(0, Math.min(pages - 1, page));
  const visible = chunks[currentPage] || [];
  while (visible.length < pageSize) visible.push('');
  const navigation = pages > 1 ? `${currentPage + 1}/${pages} [j/k] ` : '';
  const footer = width >= 76 ? `${navigation}${QUOTA_FOOTER_TEXT.trim()}`
    : width >= 24 ? `${navigation}[r] [g] [q]`
      : width >= 16 ? `${currentPage + 1}/${pages} j/k r g q` : '[q] j/k';
  return { lines: [...header, ...visible, chalk.dim(footer)].map(line => fitQuotaLine(line, width)), page: currentPage, pages };
}

export async function cmdQuota(manager) {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const restoreTerminal = () => process.stdout.write('\x1b[?25h\x1b[?1049l');
  if (interactive) {
    process.once('exit', restoreTerminal);
    process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J');
  }
  try {
    process.stdout.write(fitQuotaLine(t('loading_quota'), getTerminalWidth() - 1) + (interactive ? '' : '\n'));
    let results;
    let deadline;
    let warning;
    const refresh = async () => {
      results = await manager.collectAllQuota();
      deadline = Date.now() + QUOTA_REFRESH_INTERVAL_MS;
      warning = null;
      try { await manager.cacheQuotaResults(results); }
      catch { warning = t('quota_cache_failed'); }
    };
    await refresh();
    let showGoogle = false;
    let page = 0;
    let needsRender = true;
    let dimensions = '';
    while (true) {
      const columns = getTerminalWidth();
      const rows = process.stdout.rows || 24;
      const currentDimensions = `${columns}x${rows}`;
      if (currentDimensions !== dimensions) needsRender = true;
      if (needsRender) {
        const rootDiskLine = await getRootDiskLine();
        if (`${getTerminalWidth()}x${process.stdout.rows || 24}` !== currentDimensions) continue;
        const frame = buildQuotaFrame(results, { columns, rows, interactive, showGoogle, page, warning,
          seconds: interactive ? getQuotaRefreshCountdownSeconds(deadline) : null,
          rootDiskLine, output: process.stdout, refreshResults: manager.lastOpenAIRefreshResults });
        page = frame.page;
        if (interactive) process.stdout.write('\x1b[H\x1b[2J' + frame.lines.join('\r\n'));
        else { process.stdout.write(frame.lines.join('\n') + '\n'); break; }
        dimensions = currentDimensions;
        needsRender = false;
      }
      const action = await waitForQuotaKeypress(Math.min(1000, Math.max(0, deadline - Date.now())));
      if (action === 'resize') { needsRender = true; continue; }
      if (action === 'timeout' && Date.now() < deadline) {
        // Absolute addressing avoids saved-cursor ambiguity and terminal reflow.
        if (`${getTerminalWidth()}x${process.stdout.rows || 24}` !== dimensions) { needsRender = true; continue; }
        if (rows >= 5) {
          const now = new Date();
          updateQuotaCountdownLine(getQuotaRefreshCountdownSeconds(deadline), process.stdout, now);
        } else needsRender = true;
        continue;
      }
      if (action === 'r' || action === 'timeout') {
        try { await refresh(); }
        catch {
          warning = t('quota_refresh_failed');
          deadline = Date.now() + QUOTA_REFRESH_INTERVAL_MS;
          page = 0;
        }
      }
      else if (action === 'g') { showGoogle = !showGoogle; page = 0; }
      else if (action === 'next') page++;
      else if (action === 'previous') page--;
      else break;
      needsRender = true;
    }
  } finally {
    if (interactive) {
      process.off('exit', restoreTerminal);
      restoreTerminal();
    }
  }
}

async function runOpenAIKickoffInteractive(manager) {
  console.clear();
  printHeader();
  console.log(chalk.yellow.bold('  🧠 ' + t('running_openai_kickoff')));
  console.log();

  try {
    const batch = await manager.runOpenAIKickoffBatch();
    const results = batch.results || [];

    if (results.length === 0) {
      console.log(chalk.yellow(`  ⚠ ${t('openai_kickoff_no_targets')}`));
      console.log();
      return;
    }

    const succeeded = results.filter(result => !result.error).length;
    const failed = results.length - succeeded;

    printInfoBox(t('openai_kickoff_title'), [
      `Model: ${batch.model}`,
      `${t('openai_kickoff_targets')}: ${results.length}`,
      `${t('openai_kickoff_success')}: ${succeeded}`,
      `${t('openai_kickoff_failed')}: ${failed}`,
    ]);

    for (const [index, result] of results.entries()) {
      const label = result.nickname || result.email || result.account_id || '-';
      const suffix = result.account_id ? chalk.dim(` (${result.account_id})`) : '';
      const status = result.error ? chalk.red('✗') : chalk.green('✓');
      console.log(`  ${status} ${index + 1}. ${chalk.yellow(label)}${suffix}`);

      if (result.output_text) {
        console.log(`     ${chalk.dim(result.output_text.slice(0, 80))}`);
      }

      if (result.error) {
        console.log(`     ${chalk.red(result.error)}`);
      }

      console.log();
    }
  } catch (error) {
    console.log(chalk.red(`  ✗ ${t('error')}: ${error.message}`));
    console.log();
  }
}

async function interactiveMode(manager) {
  const authPath = manager.getAuthPath();
  if (!existsSync(authPath)) {
    if (!(await setupAuthPath(manager))) return;
  }

  let mismatchPrompted = false;

  while (true) {
    const presets = await manager.listPresets();
    const detectedPreset = await manager.detectCurrentPreset();
    const current = manager.config.current_preset;

    console.clear();
    printHeader();

    const statusItems = [];
    if (current) {
      const isMatch = detectedPreset === current;
      const icon = isMatch ? chalk.green('✓') : chalk.yellow('⚠');
      statusItems.push(`${icon} ${t('last_used_preset')}: ${chalk.cyan.bold(current)}`);
      if (!isMatch && detectedPreset) {
        statusItems.push(`  ${chalk.yellow('→')} ${t('auth_mismatch')}`);
        statusItems.push(`  ${chalk.dim('Current:')} ${detectedPreset}`);
      }
    } else {
      statusItems.push(`${chalk.gray('○')} ${t('no_preset_active')}`);
    }
    statusItems.push(`${chalk.blue('📂')} Auth: ${chalk.dim(manager.getAuthPath().replace(homedir(), '~'))}`);
    
    printInfoBox('📊 Status', statusItems);

    if (!presets.length) {
      console.log(chalk.yellow(`  ⚠ ${t('no_presets_found')}`));
      const saveNew = await confirm({ 
        message: chalk.cyan('  ' + t('save_current_as_preset')) 
      });
      if (saveNew) {
        await savePresetInteractive(manager);
      }
      return;
    }

    if (!mismatchPrompted && current && detectedPreset !== current) {
      const overwrite = await confirm({
        message: chalk.yellow('  ⚠️  ' + t('overwrite_current_preset', { 
          preset: current, 
          active: detectedPreset || t('no_preset_active') 
        })),
        default: false,
      });
      mismatchPrompted = true;
      if (overwrite) {
        try {
          const result = await manager.overwritePresetFromCurrent(current);
          const backupLine = result.backup_path
            ? `${t('backup')}: ${result.backup_path.replace(homedir(), '~')}`
            : `${t('backup')}: -`;
          printInfoBox('✓ Success', [
            t('preset_overwritten', { name: current }),
            backupLine,
          ]);
          await input({ message: chalk.dim('Press Enter to continue...') });
          continue;
        } catch (e) {
          console.log(chalk.red(`  ✗ ${t('error')}: ${e.message}`));
          await input({ message: chalk.dim('Press Enter to continue...') });
          continue;
        }
      }
    }

    console.log(chalk.bold.cyan('  📦 Available Presets'));
    console.log(chalk.gray('  ' + BOX.h.repeat(48)));
    console.log();

    for (let i = 0; i < presets.length; i++) {
      const p = presets[i];
      const isCurrent = p.name === current;
      const isActive = p.name === detectedPreset;
      printPresetCard(p, i, isActive, isCurrent);
    }

    printMenuSection();

    const choices = buildInteractiveChoices(presets);

    const selection = await select({
      message: chalk.cyan.bold('  ➜ ' + t('select_preset')),
      choices,
      pageSize: 15,
    });

    if (!selection || selection === '__exit__') {
      console.clear();
      printHeader();
      console.log(chalk.green.bold('  👋 Goodbye!\n'));
      return;
    }

    switch (selection) {
      case '__save__':
        await savePresetInteractive(manager);
        await input({ message: chalk.dim('Press Enter to continue...') });
        break;
      case '__view__':
        await viewDescriptionInteractive(manager, presets);
        break;
      case '__quota__':
        await cmdQuota(manager);
        await input({ message: chalk.dim('Press Enter to continue...') });
        break;
      case '__openai_kickoff__':
        await runOpenAIKickoffInteractive(manager);
        await input({ message: chalk.dim('Press Enter to continue...') });
        break;
      case '__distribute_credentials__':
        await distributeCredentialsInteractive(manager);
        await input({ message: chalk.dim('Press Enter to continue...') });
        break;
      case '__delete__':
        await deletePresetInteractive(manager, presets);
        await input({ message: chalk.dim('Press Enter to continue...') });
        break;
      default:
        console.clear();
        printHeader();
        await cmdSwitch(manager, selection);
        await input({ message: chalk.dim('Press Enter to continue...') });
        return;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cleanupInput = !['q', 'quota'].includes(args[0]) ? enableEscToExit() : () => {};
  try {
    const manager = new PresetManager();
    await manager.init();

    if (!args.length) {
      await interactiveMode(manager);
      return;
    }

    const command = args[0];

    switch (command) {
      case 'save':
        if (args.length < 2) {
          console.log(chalk.red('  ✗ Usage: opm save <preset-name>'));
        } else {
          await cmdSave(manager, args[1]);
        }
        break;

      case 'switch':
        if (args.length < 2) {
          console.log(chalk.red('  ✗ Usage: opm switch <preset-name>'));
        } else {
          await cmdSwitch(manager, args[1]);
        }
        break;

      case 'q':
      case 'quota':
        await cmdQuota(manager);
        break;

      default:
        console.log(chalk.red(`  ✗ Unknown command: ${command}`));
        console.log();
        console.log(chalk.bold('  Usage:'));
        console.log('    opm              ' + chalk.dim('# Interactive mode'));
        console.log('    opm save <name>  ' + chalk.dim('# Save current auth as preset'));
        console.log('    opm switch <name> ' + chalk.dim('# Switch to preset'));
        console.log('    opm quota         ' + chalk.dim('# Show OAuth quota'));
    }
  } finally {
    cleanupInput();
  }
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(e => {
    console.error(chalk.red(`Fatal error: ${e.message}`));
    process.exit(1);
  });
}
