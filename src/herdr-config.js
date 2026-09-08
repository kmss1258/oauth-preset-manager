import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import TOML from '@iarna/toml';
import { readBytes, safePath } from './codex.js';

export const HERDR_QUOTA_TOKENS = [
  { token: '$opm_cx', fg: '#10A37F' },
  { token: '$opm_cc', fg: '#D87555' },
];

// Mask strings/comments, keeping offsets and structural punctuation for a small, conservative edit.
function structure(text) {
  return text.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^"\\])*"|'[^']*'|#[^\r\n]*/g,
    value => value.replace(/[^\r\n]/g, ' '));
}

export function addQuotaRows(source) {
  const before = TOML.parse(source);
  const rows = before.ui?.sidebar?.spaces?.rows ?? [['state_icon', 'workspace'], ['branch', 'git_status']];
  if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row))) throw new Error('Invalid Space rows');
  const missing = HERDR_QUOTA_TOKENS.filter(({ token }) => !rows.flat().some(value => (value?.token ?? value) === token));
  if (!missing.length) return source;
  const expected = TOML.parse(source);
  expected.ui ??= {};
  expected.ui.sidebar ??= {};
  expected.ui.sidebar.spaces ??= {};
  expected.ui.sidebar.spaces.rows = [...rows, ...missing.map(token => [token])];
  const mask = structure(source);
  const header = /^\s*\[ui\.sidebar\.spaces\][ \t]*\r?$/m.exec(mask);
  let updated;
  if (!header) {
    updated = source + '\n[ui.sidebar.spaces]\n' + TOML.stringify({ rows: expected.ui.sidebar.spaces.rows });
  } else {
    const start = header.index + header[0].length;
    const next = /^[ \t]*\[/m.exec(mask.slice(start));
    const end = next ? start + next.index : source.length;
    const assignment = /^[ \t]*rows[ \t]*=[ \t]*\[/m.exec(mask.slice(start, end));
    if (!assignment) {
      if (before.ui?.sidebar?.spaces?.rows != null) throw new Error('Unsupported Space rows syntax');
      updated = source.slice(0, start) + '\n' + TOML.stringify({ rows: expected.ui.sidebar.spaces.rows }) + source.slice(start);
    } else {
      const open = start + assignment.index + assignment[0].length - 1;
      let close = open + 1, depth = 1;
      for (; close < mask.length; close++) {
        if (mask[close] === '[') depth++;
        if (mask[close] === ']' && --depth === 0) break;
      }
      if (depth !== 0) throw new Error('Unclosed Space rows');
      const last = mask.slice(open + 1, close).trimEnd().at(-1);
      const additions = missing.map(value => `  [{ token = "${value.token}", fg = "${value.fg}" }],`).join('\n');
      updated = source.slice(0, close) + (last && last !== ',' ? ',' : '') + '\n' + additions + '\n' + source.slice(close);
    }
  }
  if (!isDeepStrictEqual(TOML.parse(updated), expected)) throw new Error('Cannot preserve Herdr config');
  return updated;
}

async function exclusiveFile(path, content) {
  await safePath(path);
  const file = await fs.open(path, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); }
  finally { await file.close(); }
}

// One live writer per resource. A separate reaper serializes dead-PID lock recovery.
export async function acquireHerdrLock(path) {
  await safePath(dirname(path), true);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const claim = () => exclusiveFile(path, owner);
  try { await claim(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const reaper = `${path}.reap`;
    try { await exclusiveFile(reaper, owner); }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    try {
      const bytes = await readBytes(path);
      if (bytes) {
        const { pid } = JSON.parse(bytes);
        if (!Number.isSafeInteger(pid) || pid <= 0) return null;
        try { process.kill(pid, 0); return null; }
        catch (error) { if (error.code !== 'ESRCH') return null; }
        if (!(await readBytes(path))?.equals(bytes)) return null;
        await fs.unlink(path);
      }
      try { await claim(); }
      catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    } finally { await fs.unlink(reaper); }
  }
  return async () => {
    if ((await readBytes(path))?.toString() === owner) await fs.unlink(path);
  };
}

async function replaceConfig(path, content, mode) {
  const temporary = `${path}.opm-${randomUUID()}.tmp`;
  try {
    await exclusiveFile(temporary, content);
    await fs.chmod(temporary, mode);
    await safePath(path);
    await fs.rename(temporary, path);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function ensureHerdrQuotaConfig(path, run) {
  const unlock = await acquireHerdrLock(`${path}.opm-lock`);
  if (!unlock) throw new Error('Herdr configuration is busy');
  try {
    const original = await readBytes(path);
    const source = original ? new TextDecoder('utf-8', { fatal: true }).decode(original) : '';
    const candidate = Buffer.from(addQuotaRows(source));
    if (original?.equals(candidate)) return false;
    const mode = original ? (await fs.stat(path)).mode & 0o777 : 0o600;
    const temporary = `${path}.opm-check-${randomUUID()}.toml`;
    try {
      await exclusiveFile(temporary, candidate);
      await run(['config', 'check'], { HERDR_CONFIG_PATH: temporary });
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    if (!isDeepStrictEqual(await readBytes(path), original)) throw new Error('Herdr configuration changed');
    if (original) await exclusiveFile(`${path}.opm-backup-${randomUUID()}`, original);
    await replaceConfig(path, candidate, mode);
    try { await run(['server', 'reload-config']); }
    catch (error) {
      // Never undo an intervening user edit.
      if ((await readBytes(path))?.equals(candidate)) {
        if (original) await replaceConfig(path, original, mode);
        else await fs.unlink(path);
        await run(['server', 'reload-config']).catch(() => {});
      }
      throw error;
    }
    return true;
  } finally { await unlock(); }
}
