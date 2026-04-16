#!/usr/bin/env node

import { select, input, confirm, checkbox, Separator } from '@inquirer/prompts';
import chalk from 'chalk';
import Table from 'cli-table3';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { PresetManager, timeUntilReset } from './core.js';
import { t } from './i18n.js';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../package.json');

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
      description: 'Send one GPT-5.4 mini request to each OpenAI target'
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

export function buildPresetQuotaSummary(preset, now = new Date()) {
  const snapshot = preset?.quota_snapshot;
  if (!snapshot || snapshot.provider !== 'openai') {
    return null;
  }

  const daily = snapshot.daily_percent == null ? '-' : `${snapshot.daily_percent}%`;
  const weekly = snapshot.weekly_percent == null ? '-' : `${snapshot.weekly_percent}%`;
  const lastSuccessAge = formatRelativeAge(snapshot.last_success_at, now);
  const errorText = truncateText(snapshot.last_error || '', 28);

  if (snapshot.last_error) {
    if (snapshot.last_success_at) {
      const ageSuffix = lastSuccessAge ? ` · ${lastSuccessAge}` : '';
      const errorSuffix = errorText ? ` · ${errorText}` : '';
      return {
        text: `OAI D${daily} W${weekly} · stale${ageSuffix}${errorSuffix}`,
        tone: 'warn',
      };
    }

    return {
      text: errorText ? `OAI fetch failed · ${errorText}` : 'OAI fetch failed',
      tone: 'error',
    };
  }

  const ageSuffix = lastSuccessAge ? ` · ${lastSuccessAge}` : '';
  return {
    text: `OAI D${daily} W${weekly}${ageSuffix}`,
    tone: 'info',
  };
}

function formatPresetChoiceQuotaSuffix(preset) {
  const summary = buildPresetQuotaSummary(preset);
  if (!summary) {
    return '';
  }

  const compact = truncateText(summary.text, 30);
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
  if (!process.stdin.isTTY) return;
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_str, key) => {
    if (key?.name === 'escape') {
      console.log();
      process.exit(0);
    }
  });
}

function formatPercent(value) {
  if (value == null) return chalk.gray('-');

  const width = 10;
  const filledLen = Math.max(0, Math.min(width, Math.round(value / 100 * width)));
  const emptyLen = width - filledLen;

  const barFilled = chalk.green('█'.repeat(filledLen));
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

    const providerCmp = (a.r.provider || '').localeCompare(b.r.provider || '');
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

function formatAccountLabel(result) {
  const accountId = result?.account_id || '';
  const nickname = result?.nickname;
  if (nickname && accountId) return `${nickname} (${accountId})`;
  return nickname || accountId || '-';
}

function renderOpenAIBanner(results, termWidth) {
  const openaiItems = results.filter(r => r.provider === 'openai');
  if (openaiItems.length === 0) return;

  const current = openaiItems.find(r => hasPresetLabel(r, 'Current Active'));
  const currentLabel = formatAccountLabel(current);

  const presetSet = new Set();
  for (const item of openaiItems) {
    for (const label of item.presets || []) {
      const name = extractPresetName(label);
      if (name) presetSet.add(name);
    }
  }

  const presetList = Array.from(presetSet).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const presetsRaw = presetList.length ? presetList.join(', ') : '-';
  const maxLen = Math.max(20, termWidth - 10);
  const presetsLine = presetsRaw.length > maxLen ? `${presetsRaw.slice(0, maxLen - 3)}...` : presetsRaw;

  printInfoBox(t('quota_openai_banner'), [
    `${t('quota_openai_current')}: ${currentLabel}`,
    `${t('quota_openai_presets')}: ${presetsLine}`,
  ]);
}

function getTerminalWidth() {
  return process.stdout.columns || 80;
}

function calculateColWidths(totalWidth) {
  const borderChars = 6;
  const availableWidth = Math.max(60, totalWidth - borderChars);
  
  if (availableWidth < 80) {
    return {
      provider: 9,
      daily: 18,
      reset: 10,
      weekly: 0,
      weekly_reset: 0,
      account: Math.min(30, Math.max(12, availableWidth - 38)),
    };
  } else if (availableWidth < 100) {
    return {
      provider: 11,
      daily: 18,
      reset: 12,
      weekly: 18,
      weekly_reset: 12,
      account: Math.min(30, Math.max(12, availableWidth - 66)),
    };
  } else {
    return {
      provider: 13,
      daily: 18,
      reset: 12,
      weekly: 18,
      weekly_reset: 12,
      account: Math.min(30, Math.max(12, availableWidth - 68)),
    };
  }
}

function renderQuotaCompact(results, termWidth, showGoogleDetail = false) {
  console.log();
  console.log(chalk.bold.cyan('  📊 ' + t('quota_title')));
  console.log(chalk.gray('  ' + '─'.repeat(termWidth - 4)));
  console.log(chalk.dim('  ' + t('quota_wide_hint')));
  console.log();
  
  const normalized = normalizeQuotaResults(results);
  renderOpenAIBanner(normalized, termWidth);
  const openaiItems = normalized.filter(r => r.provider === 'openai');
  const googleItems = normalized.filter(r => r.provider === 'google');
  
  const formatQuotaRow = (result, index) => {
    const daily = result.daily || {};
    const weekly = result.weekly;
    const error = result.error;
    const accountId = result.account_id || '';
    const nickname = result.nickname || '';
    
    let providerLine = '';
    if (result.provider === 'openai') {
      providerLine = chalk.green.bold('openai');
    } else if (result.provider === 'google') {
      const label = daily.label || '';
      providerLine = chalk.blue.bold('google') + (label ? chalk.dim(` ${label}`) : '');
    }
    
    const accountLine = nickname 
      ? chalk.yellow(nickname) + chalk.dim(` (${accountId})`)
      : chalk.yellow(accountId);
    
    let quotaLine = '';
    if (error) {
      quotaLine = chalk.red(`  Error: ${error.slice(0, 60)}`);
    } else {
      const dailyPercent = daily.percent_remaining != null 
        ? (daily.percent_remaining < 20 ? chalk.red : daily.percent_remaining < 50 ? chalk.yellow : chalk.green)(`${daily.percent_remaining}%`.padStart(3))
        : chalk.gray('-  ');
      const dailyReset = daily.reset_time_iso 
        ? chalk.cyan(timeUntilReset(daily.reset_time_iso).padStart(6))
        : chalk.gray('-     ');
      
      const weeklyPercent = weekly?.percent_remaining != null
        ? (weekly.percent_remaining < 20 ? chalk.red : weekly.percent_remaining < 50 ? chalk.yellow : chalk.green)(`${weekly.percent_remaining}%`.padStart(3))
        : chalk.gray('-  ');
      const weeklyReset = weekly?.reset_time_iso
        ? chalk.cyan(timeUntilReset(weekly.reset_time_iso).padStart(6))
        : chalk.gray('-     ');
      
      quotaLine = `  ${chalk.dim('Daily:')} ${dailyPercent} ${dailyReset}  ${chalk.dim('Weekly:')} ${weeklyPercent} ${weeklyReset}`;
    }
    
    console.log(`  ${index + 1}. ${providerLine}`);
    console.log(`     ${accountLine}`);
    console.log(quotaLine);
    console.log();
  };
  
  if (openaiItems.length > 0) {
    console.log(chalk.bold.green('  ⚡ OpenAI'));
    console.log();
    for (const [i, result] of openaiItems.entries()) {
      formatQuotaRow(result, i);
    }
  }
  
  if (googleItems.length > 0) {
    if (openaiItems.length > 0) {
      console.log(chalk.gray('  ' + '─'.repeat(termWidth - 4)));
      console.log();
    }
    
    if (showGoogleDetail) {
      console.log(chalk.bold.blue(`  📦 Google (${googleItems.length} models)`));
      console.log();
      for (const [i, result] of googleItems.entries()) {
        formatQuotaRow(result, i);
      }
    } else {
      const accountId = googleItems[0]?.account_id || '';
      const nickname = googleItems[0]?.nickname || '';
      const accountDisplay = nickname 
        ? chalk.yellow(nickname) + chalk.dim(` (${accountId})`)
        : chalk.yellow(accountId);
      const avgPercent = Math.round(
        googleItems.reduce((sum, item) => sum + (item.daily?.percent_remaining || 0), 0) / googleItems.length
      );
      const lowModels = googleItems.filter(i => (i.daily?.percent_remaining || 100) < 50).map(i => i.daily?.label).filter(Boolean);
      
      console.log(chalk.bold.blue(`  📦 Google (${googleItems.length} models)`));
      console.log(`     ${accountDisplay}`);
      console.log(`     ${chalk.blue('Avg:')} ${avgPercent}%  ${lowModels.length > 0 ? chalk.yellow(`⚠️ Low: ${lowModels.slice(0, 3).join(', ')}`) : ''}`);
      console.log();
    }
  }
}

function renderQuotaTable(results) {
  if (!results || results.length === 0) {
    console.log(chalk.dim(t('quota_no_results')));
    return;
  }

  const deduped = normalizeQuotaResults(results);
  const termWidth = getTerminalWidth();
  
  if (termWidth < 80) {
    renderQuotaCompact(deduped, termWidth);
    return;
  }
  
  renderOpenAIBanner(deduped, termWidth);
  const widths = calculateColWidths(termWidth);

  const table = new Table({
    head: [
      chalk.cyan(t('quota_provider')),
      chalk.cyan(t('quota_daily')),
      chalk.cyan(t('quota_reset')),
      chalk.cyan(t('quota_weekly')),
      chalk.cyan(t('quota_weekly_reset')),
      chalk.cyan(t('quota_account')),
    ].map(h => chalk.bold(h)),
    style: { 
      head: [], 
      border: ['gray'],
      compact: true,
    },
    colWidths: [widths.provider, widths.daily, widths.reset, widths.weekly, widths.weekly_reset, widths.account],
    wordWrap: true,
  });

  const activeRows = [];
  const presetRows = [];

  for (const result of deduped) {
    const daily = result.daily || {};
    const weekly = result.weekly;
    const accountId = result.account_id || '';
    const nickname = result.nickname;
    const accountDisplay = nickname
      ? `${chalk.yellow(nickname)} ${chalk.dim(`(${accountId})`)}`
      : chalk.yellow(accountId);
    const presetsList = result.presets || [];
    const error = result.error;

    let provider = result.provider || chalk.gray('-');
    if (provider === 'google' && daily.label) {
      provider = `${chalk.blue('google')} ${chalk.dim('(' + daily.label.slice(0, widths.provider - 8) + ')')}`;
    } else if (provider === 'openai') {
      provider = chalk.green('openai');
    }

    let row;
    if (error) {
      row = [
        provider,
        chalk.red(error.slice(0, widths.daily - 2)),
        formatReset(daily.reset_time_iso),
        chalk.gray('-'),
        formatReset(weekly?.reset_time_iso),
        accountDisplay,
      ];
    } else {
      const dailyData = formatPercent(daily.percent_remaining);
      const weeklyData = formatPercent(weekly?.percent_remaining);
      
      row = [
        provider,
        dailyData,
        formatReset(daily.reset_time_iso),
        weeklyData,
        formatReset(weekly?.reset_time_iso),
        accountDisplay,
      ];
    }

    if (presetsList.some(p => p.includes('Current Active') || p.includes('Antigravity'))) {
      activeRows.push(row);
    } else {
      presetRows.push(row);
    }
  }

  for (const row of activeRows) table.push(row);
  if (activeRows.length > 0 && presetRows.length > 0) table.push([]);
  for (const row of presetRows) table.push(row);

  console.log();
  console.log(chalk.bold.cyan('  📊 ' + t('quota_title')));
  console.log();
  console.log(table.toString());
  console.log();
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

async function renderGoogleModelsDetail(results, termWidth) {
  const googleItems = results.filter(r => r.provider === 'google');
  if (googleItems.length === 0) return;
  
  console.log();
  console.log(chalk.blue.bold('  📦 Google Models Detail'));
  console.log(chalk.gray('  ' + '─'.repeat(termWidth - 4)));
  console.log();
  
  googleItems.forEach((item, i) => {
    const daily = item.daily || {};
    const percent = daily.percent_remaining != null
      ? (daily.percent_remaining < 20 ? chalk.red : daily.percent_remaining < 50 ? chalk.yellow : chalk.green)(`${daily.percent_remaining}%`.padStart(4))
      : chalk.gray('-');
    
    const reset = daily.reset_time_iso
      ? chalk.cyan(timeUntilReset(daily.reset_time_iso).padStart(6))
      : chalk.gray('-'.padStart(6));
    
    const label = daily.label || 'unknown';
    
    console.log(`  ${i + 1}. ${chalk.blue(label.padEnd(18))} ${percent} ${reset}`);
  });
  console.log();
}

function waitForQuotaKeypress() {
  if (!process.stdin.isTTY) return Promise.resolve('return');

  return new Promise(resolve => {
    const wasRawMode = process.stdin.isRaw;

    if (process.stdin.setRawMode && !wasRawMode) {
      process.stdin.setRawMode(true);
    }

    const cleanup = () => {
      process.stdin.off('data', onData);
      if (process.stdin.setRawMode && !wasRawMode) {
        process.stdin.setRawMode(false);
      }
    };

    const onData = (chunk) => {
      const text = chunk.toString('utf8');

      if (text === '\u001b') {
        cleanup();
        resolve('escape');
        return;
      }

      if (text === '\r' || text === '\n') {
        cleanup();
        resolve('return');
        return;
      }

      const key = normalizeQuotaActionKey(text);
      if (key) {
        cleanup();
        resolve(key);
      }
    };

    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

async function renderQuotaTableWithToggle(results, showGoogle = true) {
  const termWidth = getTerminalWidth();
  const normalized = normalizeQuotaResults(results);
  if (!normalized.length) {
    console.log(chalk.dim(t('quota_no_results')));
    return;
  }
  const openaiItems = normalized.filter(r => r.provider === 'openai');
  const googleItems = normalized.filter(r => r.provider === 'google');
  
  console.log();
  console.log(chalk.bold.cyan('  📊 ' + t('quota_title')));
  console.log();
  renderOpenAIBanner(normalized, termWidth);
  
  const widths = calculateColWidths(termWidth);
  
  const table = new Table({
    head: [
      chalk.cyan(t('quota_provider')),
      chalk.cyan(t('quota_daily')),
      chalk.cyan(t('quota_reset')),
      chalk.cyan(t('quota_weekly')),
      chalk.cyan(t('quota_weekly_reset')),
      chalk.cyan(t('quota_account')),
    ].map(h => chalk.bold(h)),
    style: { 
      head: [], 
      border: ['gray'],
      compact: true,
    },
    colWidths: [widths.provider, widths.daily, widths.reset, widths.weekly, widths.weekly_reset, widths.account],
    wordWrap: true,
  });
  
  const activeRows = [];
  const presetRows = [];
  const rowItems = showGoogle ? normalized : openaiItems;

  rowItems.forEach(result => {
    const daily = result.daily || {};
    const weekly = result.weekly;
    const accountId = result.account_id || '';
    const nickname = result.nickname;
    const accountDisplay = nickname
      ? `${chalk.yellow(nickname)} ${chalk.dim(`(${accountId})`)}`
      : chalk.yellow(accountId);
    const presetsList = result.presets || [];
    const error = result.error;

    let provider = result.provider || chalk.gray('-');
    if (provider === 'google') {
      provider = chalk.blue('google');
      if (daily.label) {
        provider = `${chalk.blue('google')} ${chalk.dim('(' + daily.label.slice(0, widths.provider - 8) + ')')}`;
      }
    } else if (provider === 'openai') {
      provider = chalk.green('openai');
    }

    let row;
    if (error) {
      row = [
        provider,
        chalk.red(error.slice(0, widths.daily - 2)),
        formatReset(daily.reset_time_iso),
        chalk.gray('-'),
        formatReset(weekly?.reset_time_iso),
        accountDisplay,
      ];
    } else {
      const dailyData = formatPercent(daily.percent_remaining);
      const weeklyData = formatPercent(weekly?.percent_remaining);
      const weeklyDisplay = result.provider === 'openai'
        ? weeklyData
        : chalk.gray('-');
      const weeklyResetDisplay = result.provider === 'openai'
        ? formatReset(weekly?.reset_time_iso)
        : chalk.gray('-');

      row = [
        provider,
        dailyData,
        formatReset(daily.reset_time_iso),
        weeklyDisplay,
        weeklyResetDisplay,
        accountDisplay,
      ];
    }

    if (presetsList.some(p => p.includes('Current Active') || p.includes('Antigravity'))) {
      activeRows.push(row);
    } else {
      presetRows.push(row);
    }
  });

  for (const row of activeRows) table.push(row);
  if (activeRows.length > 0 && presetRows.length > 0) table.push([]);
  for (const row of presetRows) table.push(row);
  
  console.log(table.toString());
  console.log();
  
  if (googleItems.length > 0) {
    if (showGoogle) {
      console.log(chalk.yellow(`  📂 Google models: ${googleItems.length} models shown`));
    } else {
      console.log(chalk.blue(`  📦 Google models: ${googleItems.length} models hidden`));
    }
    console.log();
  }
}

async function cmdQuota(manager) {
  console.clear();
  printHeader();
  console.log(chalk.yellow.bold('  ⏳ ' + t('loading_quota')));
  console.log();
  
  try {
    let cacheWarning = null;
    const initialResults = await manager.collectAllQuota();
    try {
      await manager.cacheQuotaResults(initialResults);
    } catch (error) {
      cacheWarning = error.message;
    }
    let normalizedResults = normalizeQuotaResults(initialResults);
    const termWidth = getTerminalWidth();
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    let showGoogleDetail = false;
    let showGoogleInTable = false;
    
    while (true) {
      console.clear();
      printHeader();

      const googleCount = normalizedResults.filter(r => r.provider === 'google').length;
      
      if (termWidth >= 80) {
        await renderQuotaTableWithToggle(normalizedResults, showGoogleInTable);
      } else {
        renderQuotaCompact(normalizedResults, termWidth, showGoogleDetail);
        if (showGoogleDetail && googleCount > 0) {
          await renderGoogleModelsDetail(normalizedResults, termWidth);
        }
      }

      if (cacheWarning) {
        console.log(chalk.red(`  ⚠ Quota cache save failed: ${cacheWarning}`));
        console.log();
      }
      
      if (!interactive) {
        break;
      }

      console.log(chalk.dim(QUOTA_FOOTER_TEXT));
      const action = await waitForQuotaKeypress();

      if (action === 'r') {
        const refreshedResults = await manager.collectAllQuota();
        cacheWarning = null;
        try {
          await manager.cacheQuotaResults(refreshedResults);
        } catch (error) {
          cacheWarning = error.message;
        }
        normalizedResults = normalizeQuotaResults(refreshedResults);
        continue;
      }

      if (action === 'g') {
        if (termWidth >= 80) {
          showGoogleInTable = !showGoogleInTable;
        } else {
          showGoogleDetail = !showGoogleDetail;
        }
        continue;
      }

      break;
    }
  } catch (e) {
    console.log(chalk.red(`  ✗ ${t('error')}: ${e.message}`));
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
  enableEscToExit();
  const manager = new PresetManager();
  await manager.init();

  const args = process.argv.slice(2);

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
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch(e => {
    console.error(chalk.red(`Fatal error: ${e.message}`));
    process.exit(1);
  });
}
