// main.ts is mend, the CLI SPEC.md specifies: it applies an edit that an AI model wrote, in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls), to a tree of text files, changing
// every file or none. Node 22 and its standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** A file's lines under SPEC.md section 3: its own line break, its lines, whether it ends with one. */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* Section 5: matching lines at three tiers. */

function trimTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every position at or after `from` where O occurs in F at `tier`. Occurrences may overlap. */
function matchAt(O: string[], F: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j]!, F[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function findFirstTier(
  O: string[],
  F: string[],
  strict: boolean,
  from: number,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = matchAt(O, F, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/**
 * Replace the O lines at `pos` in the model with N. nCtxO[j] is the O index of N[j] when N[j] is a context
 * line (written as the file's own matched line), else -1. At tier 2 every other line of N is re-indented.
 */
function applyReplacement(
  model: FileModel,
  pos: number,
  O: string[],
  N: string[],
  nCtxO: number[],
  tier: number,
): void {
  const out: string[] = [];
  const f = leadingWs(model.lines[pos] ?? '');
  const p = leadingWs(O[0] ?? '');
  for (let j = 0; j < N.length; j++) {
    const oj = nCtxO[j]!;
    if (oj >= 0) out.push(model.lines[pos + oj]!);
    else if (tier === 2) out.push(reindent(N[j]!, p, f));
    else out.push(N[j]!);
  }
  model.lines.splice(pos, O.length, ...out);
}

/** One body line of a unified hunk or a V4A chunk: ' ' context, '-' old, '+' new, '\\' marker. */
interface BodyLine {
  kind: string;
  text: string;
}

/** Split body lines into O (context + '-') and N (context + '+'), with N's context linkage into O. */
function splitBody(body: BodyLine[]): { O: string[]; N: string[]; nCtxO: number[] } {
  const O: string[] = [];
  const N: string[] = [];
  const nCtxO: number[] = [];
  for (const item of body) {
    if (item.kind === ' ') {
      nCtxO.push(O.length);
      O.push(item.text);
      N.push(item.text);
    } else if (item.kind === '-') {
      O.push(item.text);
    } else if (item.kind === '+') {
      N.push(item.text);
      nCtxO.push(-1);
    }
  }
  return { O, N, nCtxO };
}

/** Whether a `\` line follows the body's last context or `+` line (the no-final-break marker). */
function backslashAfterLastOut(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') last = k;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
}

/* Section 9: JSON edits (unchanged from the starter: it already did this section). */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* Section 6: unified diffs. */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface RawSection {
  oldP: string | null;
  newP: string | null;
  oldFrom: string | null;
  newFrom: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, spaces removed. */
function unifiedPath(raw: string): string | null {
  const cut = raw.split('\t')[0]!;
  let p = cut.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** Parse one hunk starting at line h; return the hunk and the index of the first line after its body. */
function parseHunk(lines: string[], h: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[h]!);
  const a = parseInt(m![1]!, 10);
  const body: BodyLine[] = [];
  let j = h + 1;
  const n = lines.length;
  while (j < n) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: ' ', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ kind: c, text: l.slice(1) });
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
  return { hunk: { a, body }, next: j };
}

function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { O, N, nCtxO } = splitBody(h.body);
    const noEol = backslashAfterLastOut(h.body);
    if (O.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > model.lines.length) at = model.lines.length;
      const atEnd = at === model.lines.length;
      model.lines.splice(at, 0, ...N);
      if (atEnd) model.final = !noEol;
      d += N.length;
    } else {
      const found = findFirstTier(O, model.lines, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const touchesEnd = best + O.length === model.lines.length;
      applyReplacement(model, best, O, N, nCtxO, found.tier);
      if (touchesEnd) model.final = !noEol;
      d += N.length - O.length;
    }
  }
}

function unifiedSectionEdit(sec: RawSection, strict: boolean): Edit {
  return (tree) => {
    const isCreate = sec.create || sec.oldP === null;
    if (isCreate) {
      const p = sec.newP === null ? '/dev/null' : sec.newP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusHunk = -1;
      let lastPlusIdx = -1;
      for (let hi = 0; hi < sec.hunks.length; hi++) {
        const body = sec.hunks[hi]!.body;
        for (let k = 0; k < body.length; k++) {
          if (body[k]!.kind === '+') {
            plus.push(body[k]!.text);
            lastPlusHunk = hi;
            lastPlusIdx = k;
          }
        }
      }
      let noEol = false;
      if (lastPlusHunk >= 0) {
        const body = sec.hunks[lastPlusHunk]!.body;
        noEol = body[lastPlusIdx + 1] !== undefined && body[lastPlusIdx + 1]!.kind === '\\';
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    const isDelete = sec.del || sec.newP === null;
    if (isDelete) {
      const p = sec.oldP === null ? '/dev/null' : sec.oldP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldP = sec.oldP!;
    const newP = sec.newP!;
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const model = parseFile(before);
      applyHunks(model, sec.hunks, strict, oldP);
      tree.now.set(newP, renderFile(model));
      tree.now.set(oldP, null);
      tree.moves.push({ old: oldP, nw: newP });
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const model = parseFile(before);
    applyHunks(model, sec.hunks, strict, oldP);
    tree.now.set(oldP, renderFile(model));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let inHeader = false;
  const n = lines.length;
  let i = 0;
  const newSection = (oldP: string | null, newP: string | null, oldFrom: string, newFrom: string): RawSection => {
    const s: RawSection = { oldP, newP, oldFrom, newFrom, create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('@@')) {
      if (!HUNK_RE.test(l)) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l.trimEnd());
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!, 'diff', 'diff');
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        const oldP = unifiedPath(l.slice(4));
        const newP = unifiedPath(lines[i + 1]!.slice(4));
        if (cur !== null && inHeader) {
          cur.oldP = oldP;
          cur.newP = newP;
          cur.oldFrom = 'pair';
          cur.newFrom = 'pair';
        } else {
          newSection(oldP, newP, 'pair', 'pair');
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) {
        if (cur.oldFrom !== 'pair') {
          cur.oldP = l.slice('rename from '.length).trim();
          cur.oldFrom = 'rename';
        }
      } else if (l.startsWith('rename to ')) {
        if (cur.newFrom !== 'pair') {
          cur.newP = l.slice('rename to '.length).trim();
          cur.newFrom = 'rename';
        }
      } else if (l.startsWith('new file mode')) {
        cur.create = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.del = true;
      }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/* Section 7: SEARCH/REPLACE blocks. */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = findFirstTier(oldLines, model.lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length !== 1) throw new Fail('ambiguous', path);
    applyReplacement(model, found.pos[0]!, oldLines, newLines, newLines.map(() => -1), found.tier);
    tree.now.set(path, renderFile(model));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let sep = -1;
    let j = searchIdx + 1;
    while (j < n) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '=======') {
        sep = j;
        break;
      }
      j++;
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    j = sep + 1;
    while (j < n) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      j++;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevReplaceEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(searchIdx + 1, sep), lines.slice(sep + 1, rep), strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* Section 8: V4A patches. */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: string[];
  nCtxO: number[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findFirstTier([ch.anchor], model.lines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? model.lines.length : cursor;
        model.lines.splice(at, 0, ...ch.N);
        cursor = at + ch.N.length;
      } else {
        const found = findFirstTier(ch.O, model.lines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos: number;
        if (ch.eof) {
          const ok = found.pos.filter((p) => p + ch.O.length === model.lines.length);
          if (ok.length === 0) throw new Fail('no-match', path);
          pos = ok[0]!;
        } else {
          pos = found.pos[0]!;
        }
        applyReplacement(model, pos, ch.O, ch.N, ch.nCtxO, found.tier);
        cursor = pos + ch.N.length;
      }
    }
    const out = renderFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Parse the chunks of an Update File section body; body[k] is patch line bodyStart + k (0-based). */
function parseV4aChunks(body: string[], bodyStart: number): VChunk[] {
  const chunks: VChunk[] = [];
  let cur: { anchor: string | null; eof: boolean; items: BodyLine[] } | null = null;
  const flush = (): void => {
    if (cur === null) return;
    const { O, N, nCtxO } = splitBody(cur.items);
    chunks.push({ anchor: cur.anchor, eof: cur.eof, O, N, nCtxO });
    cur = null;
  };
  for (let idx = 0; idx < body.length; idx++) {
    const l = body[idx]!;
    const lineNo = bodyStart + idx + 1;
    if (l.startsWith('@@')) {
      flush();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      cur.eof = true;
      flush();
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) {
          // A chunk starts at a body line only for the first chunk; a blank line between chunks is
          // ignored, any other body line after a chunk has closed is not a line the format allows.
          if (l === '') continue;
          throw new Exit2(`error: parse ${lineNo}`);
        }
        cur = { anchor: null, eof: false, items: [] };
      }
      cur.items.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  flush();
  return chunks;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  while (i < end) {
    while (i < end && blank(lines[i]!)) i++;
    if (i >= end) break;
    const l = lines[i]!;
    let kind: string;
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i++;
    const spanStart = i;
    let spanEnd = i;
    while (spanEnd < end) {
      const t = lines[spanEnd]!;
      if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) break;
      spanEnd++;
    }
    const span = lines.slice(spanStart, spanEnd);
    while (span.length > 0 && blank(span[span.length - 1]!)) span.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < span.length; k++) {
        const sl = span[k]!;
        if (sl === '') fileLines.push('');
        else if (sl.startsWith('+')) fileLines.push(sl.slice(1));
        else throw new Exit2(`error: parse ${spanStart + k + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      for (let k = 0; k < span.length; k++) {
        if (!blank(span[k]!)) throw new Exit2(`error: parse ${spanStart + k + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let body = span;
      let bodyStart = spanStart;
      if (body.length > 0 && body[0]!.startsWith('*** Move to: ')) {
        moveTo = body[0]!.slice('*** Move to: '.length).trim();
        body = body.slice(1);
        bodyStart = spanStart + 1;
      }
      const chunks = parseV4aChunks(body, bodyStart);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = spanEnd;
  }
  return edits;
}

/* Section 10: order and atomicity, section 2: output and exit codes, section 1: invocation. */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const suppressed = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const mv of tree.moves) {
    if (tree.original(mv.old) !== null && tree.get(mv.old) === null && tree.original(mv.nw) === null && tree.get(mv.nw) !== null) {
      rows.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      suppressed.add(mv.old);
      suppressed.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null) {
        try {
          rmSync(p, { force: true });
        } catch {
          // A path the edits deleted is gone already; nothing left to remove.
        }
      }
    }
    const writes = [...tree.now.keys()]
      .filter((p) => tree.now.get(p) !== null)
      .sort((a, b) => a.split('/').length - b.split('/').length || byteCmp(a, b));
    for (const p of writes) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, tree.now.get(p)!);
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
