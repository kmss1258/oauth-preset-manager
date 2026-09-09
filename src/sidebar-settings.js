import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readBytes, writeBytesAtomic } from './codex.js';

export const SIDEBAR_DEFAULTS = {
  version: 1, codex: true, claude: true, go: true, disk: true, ram: true, gpu: true, warnings: true,
  diskPaths: ['/'], gpuIds: null, gpuInterval: 2,
};

export function normalizeSidebarSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid sidebar settings');
  const result = { ...structuredClone(SIDEBAR_DEFAULTS), ...value };
  if (Object.keys(value).some(key => !Object.hasOwn(SIDEBAR_DEFAULTS, key)) || result.version !== 1) throw new Error('Invalid sidebar settings');
  for (const key of ['codex', 'claude', 'go', 'disk', 'ram', 'gpu', 'warnings']) {
    if (typeof result[key] !== 'boolean') throw new Error('Invalid sidebar toggle');
  }
  if (!Array.isArray(result.diskPaths) || result.diskPaths.length > 16
    || result.diskPaths.some(path => typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f\x7f-\x9f]/.test(path))) throw new Error('Invalid disk paths');
  result.diskPaths = [...new Set(result.diskPaths.map(path => resolve(path)))];
  if (result.gpuIds !== null && (!Array.isArray(result.gpuIds) || result.gpuIds.length > 64
    || result.gpuIds.some(id => typeof id !== 'string' || !/^GPU-[a-zA-Z0-9-]+$/.test(id)))) throw new Error('Invalid GPU selection');
  if (result.gpuIds) result.gpuIds = [...new Set(result.gpuIds)];
  if (![2, 5, 10].includes(result.gpuInterval)) throw new Error('Invalid GPU interval');
  return result;
}

export class SidebarSettings {
  constructor(directory = join(homedir(), '.config', 'oauth-preset-manager')) {
    this.path = join(directory, 'sidebar.json');
  }

  async load() {
    const bytes = await readBytes(this.path);
    return normalizeSidebarSettings(bytes === null ? {} : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  }

  async save(settings) {
    const next = normalizeSidebarSettings(settings);
    // Refuse to replace malformed existing settings; never touch auth/preset configuration.
    await this.load();
    await writeBytesAtomic(this.path, Buffer.from(JSON.stringify(next, null, 2) + '\n'));
    return next;
  }
}
