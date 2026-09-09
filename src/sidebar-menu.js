import { checkbox, input, select } from '@inquirer/prompts';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { t } from './i18n.js';
import { SidebarSettings } from './sidebar-settings.js';
import { formatGiB, gpuUsage } from './system-metrics.js';

export async function sidebarSettingsMenu(directory, prompts = { select, input, checkbox }, options = {}) {
  const store = options.store || new SidebarSettings(directory);
  let settings;
  try { settings = await store.load(); }
  catch { console.log(t('sidebar_config_error')); return; }
  console.log(t('sidebar_settings_scope'));
  const fields = ['codex', 'claude', 'go', 'disk', 'ram', 'gpu', 'warnings'];
  while (true) {
    const action = await prompts.select({ message: t('sidebar_settings'), choices: [
      { name: t('sidebar_items'), value: 'items' },
      { name: `${t('sidebar_disk_paths')}: ${settings.diskPaths.join(', ') || '-'}`, value: 'disks' },
      { name: `${t('sidebar_gpus')}: ${settings.gpuIds === null ? t('sidebar_all_gpus') : settings.gpuIds.length}`, value: 'gpus' },
      { name: `${t('sidebar_interval')}: ${settings.gpuInterval}s`, value: 'interval' },
      { name: t('sidebar_save'), value: 'save' },
      { name: t('sidebar_cancel'), value: 'cancel' },
    ] });
    if (!action || action === 'cancel') return;
    if (action === 'items') {
      const selected = await prompts.checkbox({ message: t('sidebar_items'), required: false,
        choices: fields.map(key => ({ name: t(`sidebar_${key}`), value: key, checked: settings[key] })) });
      for (const key of fields) settings[key] = selected.includes(key);
    } else if (action === 'disks') {
      const selected = await prompts.checkbox({ message: t('sidebar_keep_disks'), required: false,
        choices: settings.diskPaths.map(path => ({ name: path, value: path, checked: true })) });
      const path = await prompts.input({ message: t('sidebar_add_disk'), validate: value => {
        const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
        return !value || (isAbsolute(expanded) && !/[\x00-\x1f\x7f-\x9f]/.test(value)) || t('sidebar_absolute_path');
      } });
      const expanded = path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
      settings.diskPaths = [...new Set([...selected, ...(expanded ? [expanded] : [])])];
    } else if (action === 'gpus') {
      const mode = await prompts.select({ message: t('sidebar_gpus'), choices: [
        { name: t('sidebar_all_gpus'), value: 'all' }, { name: t('sidebar_pick_gpus'), value: 'pick' },
      ] });
      if (mode === 'all') settings.gpuIds = null;
      else {
        const result = await (options.gpuUsage || gpuUsage)();
        if (result.status !== 'ok') console.log(t('sidebar_gpu_unavailable'));
        const choices = result.gpus.map(row => ({ name: `GPU${row.index} ${row.name}${row.total ? ` (${formatGiB(row.total)} GiB)` : ''}`,
          value: row.uuid, checked: settings.gpuIds === null || settings.gpuIds.includes(row.uuid) }));
        for (const uuid of settings.gpuIds || []) {
          if (!choices.some(choice => choice.value === uuid)) choices.push({ name: `${uuid} (N/A)`, value: uuid, checked: true });
        }
        settings.gpuIds = await prompts.checkbox({ message: t('sidebar_pick_gpus'), choices, required: false });
      }
    } else if (action === 'interval') {
      settings.gpuInterval = await prompts.select({ message: t('sidebar_interval'),
        choices: [2, 5, 10].map(value => ({ name: `${value}s`, value })), default: settings.gpuInterval });
    } else if (action === 'save') {
      try { await store.save(settings); console.log(t('sidebar_saved')); return; }
      catch { console.log(t('sidebar_config_error')); return; }
    }
  }
}
