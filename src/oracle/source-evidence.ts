import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { NativeSourceManifest } from './types.js';

const MAX_BYTES = 2_000_000;
const SHA = /^[0-9a-f]{40}$/;
export function oracleDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, canonical(item)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function textDigest(text: string): string { return createHash('sha256').update(text).digest('hex'); }

function readable(bytes: Buffer): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Binary review evidence is unavailable.');
  return text;
}

/** The host selects the object repository; reviewed worktree files/config are never executed. */
export function readNativeSourceManifest(repositoryRoot: string, baseSha: string, headSha: string): NativeSourceManifest {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) throw new Error('Review source requires exact Git object identities.');
  let remaining = MAX_BYTES;
  const git = (args: readonly string[]) => {
    if (remaining < 1) throw new Error('Aggregate review evidence acquisition bound exceeded.');
    const bytes = execFileSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'protocol.allow=never', ...args], {
      cwd: repositoryRoot, maxBuffer: remaining, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
      // Object reads are local only. In particular, missing promisor objects
      // cannot trigger a credentialed lazy fetch or inherit candidate Git env.
      env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_ATTR_NOSYSTEM: '1' },
    });
    remaining -= bytes.length;
    return bytes;
  };
  for (const sha of [baseSha, headSha]) if (readable(git(['cat-file', '-t', sha])).trim() !== 'commit') throw new Error('Review source is not a commit.');
  const paths = new TextDecoder('utf-8', { fatal: true }).decode(git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', baseSha, headSha, '--'])).split('\0').filter(Boolean);
  if (paths.length < 1 || paths.length > 200) throw new Error('Complete review source exceeds the host bound.');
  const trees = [baseSha, headSha].map((sha) => new Map(new TextDecoder('utf-8', { fatal: true }).decode(git(['ls-tree', '-r', '-z', '--full-tree', sha, '--', ...paths])).split('\0').filter(Boolean).map((line) => {
    const match = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (match === null) throw new Error('Unsupported source object.');
    return [match[3]!, { mode: match[1]!, oid: match[2]! }] as const;
  })));
  const files = paths.sort().map((file) => {
    if (file.length > 240 || file.split('/').some((part) => !/^[A-Za-z0-9._@+-]+$/.test(part) || part === '.' || part === '..')) throw new Error('Unsupported source path.');
    const blobs = trees.map((tree) => {
      const entry = tree.get(file);
      if (entry === undefined) return null;
      if (entry.mode !== '100644' && entry.mode !== '100755') throw new Error('Nonregular review source is unavailable.');
      const bytes = git(['cat-file', 'blob', entry.oid]);
      const actual = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (actual !== entry.oid) throw new Error('Source blob identity mismatch.');
      const text = readable(bytes);
      return { oid: entry.oid, text, sha256: textDigest(text) };
    });
    return { path: file, base: blobs[0]!, head: blobs[1]! };
  });
  const diff = readable(git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', '--binary', baseSha, headSha, '--']));
  const manifest = { baseSha, headSha, files, diff, sourceSha256: oracleDigest(files), diffSha256: textDigest(diff) };
  if (!validNativeSourceManifest(manifest)) throw new Error('Incomplete or oversized review evidence.');
  return manifest;
}

export function validNativeSourceManifest(value: unknown): value is NativeSourceManifest {
  try {
    const m = value as NativeSourceManifest;
    if (!m || !SHA.test(m.baseSha) || !SHA.test(m.headSha) || !Array.isArray(m.files) || m.files.length < 1 || m.files.length > 200 ||
      typeof m.diff !== 'string' || m.diff.length === 0 || m.diff.includes('\0') || Buffer.byteLength(JSON.stringify(m)) > MAX_BYTES ||
      m.sourceSha256 !== oracleDigest(m.files) || m.diffSha256 !== textDigest(m.diff) || new Set(m.files.map((f) => f.path)).size !== m.files.length) return false;
    return m.files.every((file) => typeof file.path === 'string' && file.path.length <= 240 && file.path.split('/').every((p: string) => /^[A-Za-z0-9._@+-]+$/.test(p) && p !== '.' && p !== '..') &&
      (file.base !== null || file.head !== null) && [file.base, file.head].every((blob) => blob === null ||
        typeof blob.text === 'string' && !blob.text.includes('\0') && blob.sha256 === textDigest(blob.text) && SHA.test(blob.oid) &&
        createHash('sha1').update(`blob ${Buffer.byteLength(blob.text)}\0`).update(blob.text).digest('hex') === blob.oid));
  } catch { return false; }
}
