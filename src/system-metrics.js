import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const GIB = 1024 ** 3;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function capacity(used, total) {
  if (!finite(used) || !finite(total) || total === 0 || used > total) throw new Error('Invalid capacity');
  return { used, total, percent: used / total * 100 };
}

export function formatGiB(bytes) {
  const value = bytes / GIB;
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}

export async function diskUsage(path, { statfs = fs.statfs, stat = fs.stat } = {}) {
  try {
    const [space, file] = await Promise.all([statfs(path, { bigint: true }), stat(path)]);
    return { path, device: file.dev, status: 'ok',
      ...capacity(Number((space.blocks - space.bfree) * space.bsize), Number(space.blocks * space.bsize)) };
  } catch { return { path, status: 'error' }; }
}

export function parseMeminfo(text) {
  const values = new Map([...text.matchAll(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB\s*$/gm)]
    .map(([, key, value]) => [key, Number(value) * 1024]));
  if (!values.has('MemAvailable') || !values.has('MemTotal')) throw new Error('Missing memory data');
  return capacity(values.get('MemTotal') - values.get('MemAvailable'), values.get('MemTotal'));
}

export async function ramUsage({ platform = process.platform, readFile = fs.readFile, total = totalmem, free = freemem } = {}) {
  try {
    if (platform === 'linux') {
      const text = await readFile('/proc/meminfo', 'utf8');
      if (/^MemAvailable:/m.test(text)) return { status: 'ok', ...parseMeminfo(text) };
    }
    const size = total();
    return { status: 'ok', approximate: true, ...capacity(size - free(), size) };
  } catch { return { status: 'error' }; }
}

export function parseGpuUsage(text) {
  const rows = [];
  const seen = new Set();
  for (const line of text.trim().split(/\r?\n/)) {
    const fields = line.split(',').map(value => value.trim());
    if (fields.length < 5) continue;
    const [indexText, uuid] = fields;
    if (!/^\d+$/.test(indexText) || !Number.isSafeInteger(Number(indexText))
      || !/^GPU-[a-zA-Z0-9-]+$/.test(uuid) || seen.has(uuid) || rows.some(row => row.index === Number(indexText))) continue;
    seen.add(uuid);
    const row = { index: Number(indexText), uuid, name: fields.slice(2, -2).join(', ').replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 80), status: 'error' };
    const numeric = value => /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1024 ** 2 : NaN;
    try { Object.assign(row, capacity(numeric(fields.at(-2)), numeric(fields.at(-1))), { status: 'ok' }); } catch {}
    rows.push(row);
  }
  return rows.sort((a, b) => a.index - b.index);
}

export async function gpuUsage(run = execute) {
  try {
    const { stdout } = await run('nvidia-smi', [
      '--query-gpu=index,uuid,name,memory.used,memory.total', '--format=csv,noheader,nounits',
    ], { timeout: 1500, maxBuffer: 128 * 1024, encoding: 'utf8', windowsHide: true });
    const gpus = parseGpuUsage(stdout);
    if (!gpus.length && stdout.trim() && !/no devices were found/i.test(stdout)) return { status: 'error', gpus: [] };
    return { status: 'ok', gpus };
  } catch (error) {
    if (error.code === 'ENOENT' || /no devices were found/i.test(String(error.stdout))) return { status: 'missing', gpus: [] };
    return { status: 'error', gpus: [] };
  }
}

export class SystemMetrics {
  constructor({ disk = diskUsage, ram = ramUsage, gpu = gpuUsage, now = Date.now } = {}) {
    Object.assign(this, { disk, ram, gpu, now });
    this.values = { disks: [], ram: null, gpus: [], gpuStatus: 'missing' };
    this.deadlines = {}; this.pending = {}; this.lastGpu = new Map(); this.signatures = {};
  }

  // Independent non-overlapping polls: a slow nvidia-smi must not block RAM or disk.
  poll(settings, changed = () => {}, force = false) {
    const tasks = [];
    const launch = (key, enabled, interval, selection, action) => {
      const signature = JSON.stringify([enabled, selection]);
      if (this.signatures[key] !== signature) {
        this.signatures[key] = signature; this.deadlines[key] = 0;
        if (key === 'disk') this.values.disks = [];
        if (key === 'ram') this.values.ram = null;
        if (key === 'gpu') { this.values.gpus = []; this.values.gpuStatus = 'missing'; }
      }
      if (!enabled || this.pending[key] || (!force && (this.deadlines[key] || 0) > this.now())) return;
      this.deadlines[key] = this.now() + interval;
      const task = Promise.resolve().then(action).then(patch => {
        if (this.signatures[key] === signature) { Object.assign(this.values, patch); return changed(); }
      }).finally(() => { delete this.pending[key]; });
      this.pending[key] = task; tasks.push(task);
    };
    launch('disk', settings.disk, 15000, settings.diskPaths, async () => {
      const rows = await Promise.all(settings.diskPaths.map(path => Promise.resolve().then(() => this.disk(path)).catch(() => ({ path, status: 'error' }))));
      const devices = new Set();
      return { disks: rows.filter(row => {
        if (row.status !== 'ok' || row.device == null) return true;
        if (devices.has(row.device)) return false;
        devices.add(row.device); return true;
      }) };
    });
    launch('ram', settings.ram, 2000, null, async () => ({ ram: await Promise.resolve().then(() => this.ram()).catch(() => ({ status: 'error' })) }));
    launch('gpu', settings.gpu && (settings.gpuIds === null || settings.gpuIds.length > 0), settings.gpuInterval * 1000, settings.gpuIds, async () => {
      const result = await Promise.resolve().then(() => this.gpu()).catch(() => ({ status: 'error', gpus: [] }));
      for (const row of result.gpus) this.lastGpu.set(row.uuid, { index: row.index, uuid: row.uuid, name: row.name });
      const current = new Map(result.gpus.map(row => [row.uuid, row]));
      const ids = settings.gpuIds === null ? [...this.lastGpu.keys()] : settings.gpuIds;
      return { gpus: ids.map(uuid => current.get(uuid) || {
        ...(this.lastGpu.get(uuid) || { uuid, index: null, name: 'GPU' }), status: 'error',
      }).sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity)), gpuStatus: result.status };
    });
    return Promise.allSettled(tasks);
  }
}
