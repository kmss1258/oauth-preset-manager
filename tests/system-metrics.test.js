import assert from 'node:assert/strict';
import test from 'node:test';
import { capacity, diskUsage, formatGiB, gpuUsage, parseGpuUsage, parseMeminfo, ramUsage, SystemMetrics } from '../src/system-metrics.js';
import { SIDEBAR_DEFAULTS } from '../src/sidebar-settings.js';

const csv = '1, GPU-bbb, NVIDIA RTX 3060 Ti, 1024, 8192\n0, GPU-aaa, NVIDIA RTX 4060 Ti, 6144, 16384\n';
const settings = { ...SIDEBAR_DEFAULTS };

test('disk uses bfree, not available blocks, and isolates missing paths', async () => {
  const row = await diskUsage('/', { statfs: async () => ({ blocks: 100n, bfree: 20n, bavail: 10n, bsize: 1024n }), stat: async () => ({ dev: 1 }) });
  assert.equal(row.percent, 80); assert.equal(row.used, 81920); assert.equal(row.device, 1);
  assert.deepEqual(await diskUsage('/missing', { statfs: async () => { throw 0; } }), { path: '/missing', status: 'error' });
  for (const [used, total] of [[0, 0], [-1, 2], [3, 2], [NaN, 2], [0, Infinity]]) assert.throws(() => capacity(used, total));
  assert.equal(formatGiB(6.25 * 1024 ** 3), '6.3');
  assert.equal(formatGiB(930 * 1024 ** 3), '930');
});

test('RAM uses MemAvailable and labels OS fallback approximate, not fake zero', async () => {
  const text = 'MemTotal:  64000 kB\nMemFree: 1000 kB\nMemAvailable: 40000 kB\n';
  assert.equal(parseMeminfo(text).used, 24000 * 1024);
  assert.equal((await ramUsage({ platform: 'linux', readFile: async () => text })).approximate, undefined);
  assert.deepEqual(await ramUsage({ platform: 'darwin', total: () => 100, free: () => 20 }), { status: 'ok', approximate: true, used: 80, total: 100, percent: 80 });
  assert.equal((await ramUsage({ platform: 'linux', readFile: async () => 'MemTotal: 1 kB', total: () => 100, free: () => 20 })).approximate, true);
  assert.equal((await ramUsage({ platform: 'linux', readFile: async () => { throw 0; } })).status, 'error');
  assert.throws(() => parseMeminfo('MemTotal: 1 kB\nMemAvailable: 2 kB'));
});

test('one bounded shell-free GPU command parses multiple devices despite stderr warnings', async () => {
  let calls = 0;
  const result = await gpuUsage(async (command, args, options) => {
    calls++; assert.equal(command, 'nvidia-smi'); assert.equal(args.length, 2);
    assert.equal(options.timeout, 1500); assert.equal(options.shell, undefined);
    assert.equal(options.maxBuffer, 128 * 1024);
    return { stdout: csv, stderr: 'nvidia-modprobe: unrecognized option: -s' };
  });
  assert.equal(calls, 1); assert.equal(result.status, 'ok');
  assert.deepEqual(result.gpus.map(row => row.index), [0, 1]);
  assert.equal(result.gpus[0].used, 6 * 1024 ** 3);
  assert.equal(result.gpus[1].percent, 12.5);
  assert.equal(parseGpuUsage(csv + '2, GPU-ccc, device, N/A, 8000')[2].status, 'error');
  assert.equal(parseGpuUsage(csv + csv).length, 2);
  assert.deepEqual(parseGpuUsage('garbage'), []);
  assert.equal((await gpuUsage(async () => { throw { code: 'ENOENT' }; })).status, 'missing');
  assert.equal((await gpuUsage(async () => { throw { killed: true }; })).status, 'error');
  assert.equal((await gpuUsage(async () => ({ stdout: '' }))).gpus.length, 0);
  assert.equal((await gpuUsage(async () => ({ stdout: 'malformed' }))).status, 'error');
});

test('independent clocks, deduped disks, UUID selection and removed GPU failure', async () => {
  let now = 1000, missing = false;
  const count = { disk: 0, ram: 0, gpu: 0 };
  const metrics = new SystemMetrics({ now: () => now,
    disk: async path => { count.disk++; return { path, device: 1, status: 'ok', ...capacity(1, 2) }; },
    ram: async () => { count.ram++; return { status: 'ok', ...capacity(1, 2) }; },
    gpu: async () => { count.gpu++; return { status: missing ? 'error' : 'ok', gpus: missing ? [] : parseGpuUsage(csv) }; },
  });
  const config = { ...settings, diskPaths: ['/', '/home'] };
  await metrics.poll(config); assert.equal(metrics.values.disks.length, 1);
  await metrics.poll(config); assert.deepEqual(count, { disk: 2, ram: 1, gpu: 1 });
  now += 2000; await metrics.poll(config); assert.deepEqual(count, { disk: 2, ram: 2, gpu: 2 });
  now += 13000; await metrics.poll(config); assert.equal(count.disk, 4);
  await metrics.poll({ ...config, gpuIds: ['GPU-bbb'] });
  assert.deepEqual(metrics.values.gpus.map(row => row.index), [1]);
  missing = true; now += 2000; await metrics.poll({ ...config, gpuIds: ['GPU-bbb'] });
  assert.equal(metrics.values.gpus[0].status, 'error'); assert.equal(metrics.values.gpus[0].used, undefined);
  const before = { ...count };
  now += 30000; await metrics.poll({ ...config, disk: false, ram: false, gpu: false });
  assert.deepEqual(count, before);
});

test('slow GPU does not block RAM, overlap, or publish after selection changes', async () => {
  let complete, gpuCalls = 0, ramCalls = 0, now = 1;
  const metrics = new SystemMetrics({ now: () => now,
    ram: async () => { ramCalls++; return { status: 'ok', ...capacity(1, 2) }; },
    gpu: () => { gpuCalls++; return new Promise(resolve => { complete = resolve; }); },
  });
  const config = { ...settings, disk: false };
  const first = metrics.poll(config);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(metrics.values.ram.status, 'ok');
  now += 2000; await metrics.poll(config); assert.equal(ramCalls, 2); assert.equal(gpuCalls, 1);
  await metrics.poll({ ...config, gpu: false });
  complete({ status: 'ok', gpus: parseGpuUsage(csv) }); await first;
  assert.deepEqual(metrics.values.gpus, []);
});
