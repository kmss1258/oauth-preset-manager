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

function formatPercent(value) {
  if (value == null) return '-';

  const width = 10;
  const filledLen = Math.max(0, Math.min(width, Math.round(value / 100 * width)));
  const emptyLen = width - filledLen;

  const bar = '='.repeat(filledLen) + '-'.repeat(emptyLen);

  let color = chalk.green;
  if (value < 20) color = chalk.red;
  else if (value < 50) color = chalk.yellow;

  return `${color(`[${bar}]`)} ${value.toString().padStart(3)}%`;
}

function formatReset(value) {
  if (!value) return '-';
  return timeUntilReset(value);
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
      t('quota_provider'),
      t('quota_daily'),
      t('quota_daily_reset'),
      t('quota_weekly'),
      t('quota_weekly_reset'),
      t('quota_account'),
      t('quota_presets'),
      t('quota_error'),
    ],
    style: { head: ['cyan'] },
    wordWrap: true,
    wrapOnWordBoundary: false,
  });

  const activeRows = [];
  const presetRows = [];

  for (const result of deduped) {
    const daily = result.daily || {};
    const weekly = result.weekly || {};
    const account = result.account_id || '-';
    const presetsList = result.presets || [];
    const presets = presetsList.join(', ').slice(0, 40);
    const error = result.error || '-';

    let provider = result.provider || '-';
    if (provider === 'google' && daily.label) {
      provider = `${provider}\n(${daily.label})`;
    }

    const row = [
      provider,
      formatPercent(daily.percent_remaining),
      formatReset(daily.reset_time_iso),
      formatPercent(weekly?.percent_remaining),
      formatReset(weekly?.reset_time_iso),
      account.slice(0, 25),
      presets || '-',
      error !== '-' ? chalk.red(error.slice(0, 30)) : '-',
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

  console.log(chalk.bold.cyan(`\n${t('quota_title')}\n`));
  console.log(table.toString());
  console.log();
}

function printSwitchResult(result) {
  console.log(`\n${chalk.green('✓')} ${t('switched_to')}: ${chalk.bold(result.preset_name)}`);

  if (result.backup_path) {
    console.log(`  ${chalk.dim(`📦 Backup: ${result.backup_path.replace(homedir(), '~')}`)}`);
  }

  const diff = result.diff || {};
  if (diff.added?.length || diff.removed?.length || diff.modified?.length) {
    console.log(`\n${chalk.dim(`🔄 ${t('updated_services')}`)}`);
    if (diff.added?.length) {
      console.log(`  ${chalk.green(`+ ${t('added')}:`)} ${diff.added.join(', ')}`);
    }
    if (diff.removed?.length) {
      console.log(`  ${chalk.red(`- ${t('removed')}:`)} ${diff.removed.join(', ')}`);
    }
    if (diff.modified?.length) {
      console.log(`  ${chalk.yellow(`~ ${t('modified')}:`)} ${diff.modified.join(', ')}`);
    }
  } else {
    console.log(`\n${chalk.dim(t('no_changes_detected'))}`);
  }
}

async function setupAuthPath(manager) {
  const defaultPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');

  if (existsSync(defaultPath)) {
    console.log(`${chalk.green('✓')} ${t('found_opencode_auth')}: ${defaultPath.replace(homedir(), '~')}`);
    await manager.setAuthPath(defaultPath);
    return true;
  }

  console.log(`${chalk.yellow('⚠')} ${t('auth_not_found')}`);

  const customPath = await input({
    message: t('enter_auth_path'),
    default: defaultPath,
  });

  if (customPath && existsSync(customPath)) {
    await manager.setAuthPath(customPath);
    console.log(`${chalk.green('✓')} ${t('auth_path_set')}: ${customPath}`);
    return true;
  }

  console.log(`${chalk.red('✗')} ${t('invalid_path')}`);
  return false;
}

async function viewDescriptionInteractive(manager, presets) {
  const table = new Table({
    head: [t('preset'), t('description'), t('watched'), t('last_used')],
    style: { head: ['cyan'] },
  });

  for (const p of presets) {
    const info = await manager.getPresetInfo(p.name);
    const meta = info?.metadata || {};
    const watched = (meta.watched_services || ['openai']).join(', ');
    table.push([
      p.name + (p.is_current ? ' *' : ''),
      meta.description || '',
      watched,
      p.last_used || '',
    ]);
  }

  console.log(table.toString());
  await input({ message: 'Press Enter to continue...' });
}

async function savePresetInteractive(manager) {
  const authPath = manager.getAuthPath();
  if (!existsSync(authPath)) {
    console.log(`${chalk.red('✗')} ${t('auth_file_not_found')}`);
    return;
  }

  const name = await input({
    message: t('enter_preset_name'),
    validate: (text) => text?.length > 0 || t('name_required'),
  });

  if (!name) return;

  const description = await input({ message: t('enter_description') });

  let availableServices = [];
  try {
    const data = JSON.parse(await (await import('fs')).promises.readFile(authPath, 'utf-8'));
    availableServices = Object.keys(data);
  } catch {}

  let watchedServices = ['openai'];
  if (availableServices.length > 0) {
    watchedServices = await checkbox({
      message: t('watched_services_prompt'),
      choices: availableServices.map(s => ({ name: s, value: s, checked: s === 'openai' })),
    });
    if (!watchedServices?.length) watchedServices = ['openai'];
  }

  try {
    await manager.savePreset(name, description || '', watchedServices);
    console.log(`\n${chalk.green('✓')} ${t('saved_preset')}: ${chalk.bold(name)}`);
  } catch (e) {
    console.log(`${chalk.red('✗')} ${t('error')}: ${e.message}`);
  }
}

async function deletePresetInteractive(manager, presets) {
  if (!presets.length) return;

  const choices = presets.map(p => ({ name: p.name, value: p.name }));
  const selection = await select({
    message: t('select_preset_to_delete'),
    choices,
  });

  if (!selection) return;

  const confirmed = await confirm({
    message: t('confirm_delete', { name: selection }),
    default: false,
  });

  if (confirmed) {
    try {
      await manager.deletePreset(selection);
      console.log(`\n${chalk.green('✓')} ${t('deleted_preset')}: ${chalk.bold(selection)}`);
    } catch (e) {
      console.log(`${chalk.red('✗')} ${t('error')}: ${e.message}`);
    }
  }
}

async function cmdSave(manager, name) {
  try {
    const authPath = manager.getAuthPath();
    if (!existsSync(authPath)) {
      console.log(`${chalk.red('✗')} ${t('auth_file_not_found')}: ${authPath}`);
      return;
    }

    await manager.savePreset(name);
    console.log(`${chalk.green('✓')} ${t('saved_preset')}: ${chalk.bold(name)}`);
  } catch (e) {
    console.log(`${chalk.red('✗')} ${t('error')}: ${e.message}`);
  }
}

async function cmdSwitch(manager, name) {
  try {
    const result = await manager.switchPreset(name);
    printSwitchResult(result);
  } catch (e) {
    if (e.message.includes('not found')) {
      console.log(`${chalk.red('✗')} ${t('preset_not_found')}: ${name}`);
    } else {
      console.log(`${chalk.red('✗')} ${t('error')}: ${e.message}`);
    }
  }
}

async function cmdQuota(manager) {
  console.log(chalk.yellow(t('loading_quota')));
  try {
    const results = await manager.collectAllQuota();
    renderQuotaTable(results);
  } catch (e) {
    console.log(`${chalk.red('✗')} ${t('error')}: ${e.message}`);
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

    if (!presets.length) {
      console.log(`\n${chalk.yellow(t('no_presets_found'))}`);
      const saveNew = await confirm({ message: t('save_current_as_preset') });
      if (saveNew) {
        await savePresetInteractive(manager);
      }
      return;
    }

    console.log();

    const detectedPreset = await manager.detectCurrentPreset();
    const current = manager.config.current_preset;

    if (!mismatchPrompted && current && detectedPreset !== current) {
      const activeLabel = detectedPreset || t('no_preset_active');
      console.log(`${chalk.yellow('⚠')} ${chalk.dim(t('auth_mismatch'))}`);
      const overwrite = await confirm({
        message: t('overwrite_current_preset', { preset: current, active: activeLabel }),
        default: false,
      });
      mismatchPrompted = true;
      if (overwrite) {
        try {
          const result = await manager.switchPreset(current);
          printSwitchResult(result);
        } catch (e) {
          console.log(`${chalk.red('✗')} ${t('error')}: ${e.message}`);
        }
      }
    }

    if (current) {
      console.log(`${chalk.bold.cyan(`${t('last_used_preset')}:`)} ${current}`);
    } else {
      console.log(chalk.dim(t('no_preset_active')));
    }

    const choices = [
      ...presets.map(p => ({ name: p.name, value: p.name })),
      new Separator(),
      { name: t('save_new_preset'), value: '__save__' },
      { name: t('view_description'), value: '__view__' },
      { name: t('view_quota'), value: '__quota__' },
      { name: t('delete_preset'), value: '__delete__' },
      { name: t('exit'), value: '__exit__' },
    ];

    const selection = await select({
      message: t('select_preset'),
      choices,
    });

    if (!selection || selection === '__exit__') return;

    switch (selection) {
      case '__save__':
        await savePresetInteractive(manager);
        break;
      case '__view__':
        await viewDescriptionInteractive(manager, presets);
        break;
      case '__quota__':
        await cmdQuota(manager);
        await input({ message: 'Press Enter to continue...' });
        break;
      case '__delete__':
        await deletePresetInteractive(manager, presets);
        break;
      default:
        await cmdSwitch(manager, selection);
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
        console.log(`${chalk.red('✗')} Usage: opm save <preset-name>`);
      } else {
        await cmdSave(manager, args[1]);
      }
      break;

    case 'switch':
      if (args.length < 2) {
        console.log(`${chalk.red('✗')} Usage: opm switch <preset-name>`);
      } else {
        await cmdSwitch(manager, args[1]);
      }
      break;

    case 'q':
    case 'quota':
      await cmdQuota(manager);
      break;

    default:
      console.log(`${chalk.red('✗')} Unknown command: ${command}`);
      console.log(`\n${chalk.bold('Usage:')}`);
      console.log('  opm              # Interactive mode');
      console.log('  opm save <name>  # Save current auth as preset');
      console.log('  opm switch <name> # Switch to preset');
      console.log('  opm quota         # Show OAuth quota');
  }
}

main().catch(e => {
  console.error(chalk.red(`Fatal error: ${e.message}`));
  process.exit(1);
});
