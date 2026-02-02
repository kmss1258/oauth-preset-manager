#!/usr/bin/env node

import { select, input, confirm, checkbox, Separator } from '@inquirer/prompts';
import chalk from 'chalk';
import Table from 'cli-table3';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { PresetManager, timeUntilReset } from './core.js';
import { t } from './i18n.js';

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
  console.log(chalk.dim('   OAuth Preset Manager ') + chalk.yellow('v1.0.0') + chalk.dim(' - Node.js Edition'));
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
  console.log();
}

function printMenuSection() {
  console.log();
  console.log(chalk.gray('  ' + BOX.h.repeat(48)));
  console.log(chalk.cyan.bold('  ⚡ ACTIONS'));
  console.log(chalk.gray('  ' + BOX.h.repeat(48)));
  console.log();
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

function formatReset(value) {
  if (!value) return chalk.gray('-');
  const time = timeUntilReset(value);
  if (time === 'Resetting...') return chalk.yellow(time);
  return chalk.cyan(time);
}

function deduplicateResults(results) {
  const seen = new Map();
  
  for (const result of results) {
    const key = `${result.provider}-${result.account_id}-${result.daily?.label || 'default'}`;
    const existing = seen.get(key);
    
    if (!existing) {
      seen.set(key, result);
    } else if (result.error && !existing.error) {
      existing.error = result.error;
    }
  }
  
  return Array.from(seen.values());
}

function renderQuotaTable(results) {
  if (!results || results.length === 0) {
    console.log(chalk.dim(t('quota_no_results')));
    return;
  }

  const deduped = deduplicateResults(results);

  const table = new Table({
    head: [
      chalk.cyan(t('quota_provider')),
      chalk.cyan(t('quota_daily')),
      chalk.cyan(t('quota_reset')),
      chalk.cyan(t('quota_account')),
      chalk.cyan(t('quota_presets')),
    ].map(h => chalk.bold(h)),
    style: { 
      head: [], 
      border: ['gray'],
      compact: true,
    },
    colWidths: [16, 20, 10, 28, 35],
    wordWrap: true,
  });

  const activeRows = [];
  const presetRows = [];

  for (const result of deduped) {
    const daily = result.daily || {};
    const weekly = result.weekly;
    const account = result.account_id || chalk.gray('-');
    const presetsList = result.presets || [];
    const presets = presetsList.join(', ').slice(0, 33);
    const error = result.error;

    let provider = result.provider || chalk.gray('-');
    if (provider === 'google' && daily.label) {
      provider = `${chalk.blue('google')}\n${chalk.dim('(' + daily.label + ')')}`;
    } else if (provider === 'openai') {
      provider = chalk.green('openai');
    }

    const dailyDisplay = error 
      ? chalk.red(error.slice(0, 20))
      : formatPercent(daily.percent_remaining);

    const row = [
      provider,
      dailyDisplay,
      formatReset(daily.reset_time_iso),
      chalk.yellow(account.slice(0, 25)),
      chalk.dim(presets || '-'),
    ];

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
  const defaultPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');

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

async function cmdQuota(manager) {
  console.clear();
  printHeader();
  console.log(chalk.yellow.bold('  ⏳ ' + t('loading_quota')));
  console.log();
  
  try {
    const results = await manager.collectAllQuota();
    console.clear();
    printHeader();
    renderQuotaTable(results);
  } catch (e) {
    console.log(chalk.red(`  ✗ ${t('error')}: ${e.message}`));
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
          const result = await manager.switchPreset(current);
          printSwitchResult(result);
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

    const choices = [
      ...presets.map((p, i) => ({ 
        name: `  ${chalk.cyan(i + 1 + '.')} ${p.is_current ? chalk.green('●') : chalk.gray('○')} ${p.name}`, 
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

main().catch(e => {
  console.error(chalk.red(`Fatal error: ${e.message}`));
  process.exit(1);
});
