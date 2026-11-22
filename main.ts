// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

// ---- Section 5: finding lines, shared by the three readers below ----

/** A move an edit made, so the output can print one R line for the pair. */
type MovePair = { old: string; nw: string };

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function lineEq(tier: number, fileLine: string, oldLine: string): boolean {
  if (tier === 0) return fileLine === oldLine;
  if (tier === 1) return stripTrail(fileLine) === stripTrail(oldLine);
  return stripBoth(fileLine) === stripBoth(oldLine);
}

/** Where O occurs in lines at one tier, starting at `from`; overlaps count. */
function hitsAt(lines: string[], oldLines: string[], tier: number, from: number): number[] {
  const hits: number[] = [];
  const k = oldLines.length;
  if (k === 0) return hits;
  for (let i = from; i + k <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (!lineEq(tier, lines[i + j]!, oldLines[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** The first tier (0, then 1, then 2; only 0 when strict) where O occurs at least once from `from`. */
function firstTierWith(lines: string[], oldLines: string[], from: number, strict: boolean): { tier: number; hits: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const hits = hitsAt(lines, oldLines, tier, from);
    if (hits.length > 0) return { tier, hits };
  }
  return null;
}

/** The first line at or after `from` equal to a single line, at the first tier where one is. */
function firstTierSingle(lines: string[], one: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineEq(tier, lines[i]!, one)) return i;
    }
  }
  return null;
}

/** A file's text split the way section 3 says: its break, its lines, whether it ends with a break. */
function splitFile(text: string): { br: string; lines: string[]; finalBreak: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], finalBreak: false };
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function joinFile(lines: string[], br: string, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

/** One body line of a hunk or a chunk. `blank` marks a literally empty line. */
type BodyLine = { kind: 'ctx' | 'old' | 'new' | 'slash'; text: string; blank: boolean };

/** One line of N: a context line (written as the file's own line at its place in O) or a fresh line. */
type NewLine = { ctx: number | null; text: string };

/** Split a hunk or chunk body into its old lines O and its new lines N. */
function bodyParts(body: BodyLine[]): { oldLines: string[]; fresh: NewLine[] } {
  const oldLines: string[] = [];
  const fresh: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      oldLines.push(b.text);
      fresh.push({ ctx: oldLines.length - 1, text: b.text });
    } else if (b.kind === 'old') {
      oldLines.push(b.text);
    } else if (b.kind === 'new') {
      fresh.push({ ctx: null, text: b.text });
    }
  }
  return { oldLines, fresh };
}

/** Replace O at `at` with N; context lines come from the file, fresh lines get the tier-2 re-indent. */
function spliceLines(lines: string[], at: number, oldLines: string[], fresh: NewLine[], tier: number): string[] {
  const out = lines.slice(0, at);
  let f = '';
  let p = '';
  if (tier === 2 && oldLines.length > 0) {
    f = leadingWs(lines[at]!);
    p = leadingWs(oldLines[0]!);
  }
  for (const nl of fresh) {
    if (nl.ctx !== null) {
      out.push(lines[at + nl.ctx]!);
    } else {
      let t = nl.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  out.push(...lines.slice(at + oldLines.length));
  return out;
}

/** Insert plain lines at `at`. */
function insertLines(lines: string[], at: number, added: string[]): string[] {
  return [...lines.slice(0, at), ...added, ...lines.slice(at)];
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  body: BodyLine[];
  lastNoEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  remove: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim();
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function nullPath(p: string): string | null {
  return p === '/dev/null' ? null : stripAB(p);
}

/** Read one hunk body starting after the header at `at`; return the line after the body. */
function readHunk(lines: string[], at: number, a: number, sec: Section): number {
  const body: BodyLine[] = [];
  let j = at + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: 'ctx', text: '', blank: true });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      body.push({ kind: 'ctx', text: l.slice(1), blank: false });
      j += 1;
    } else if (c === '-') {
      body.push({ kind: 'old', text: l.slice(1), blank: false });
      j += 1;
    } else if (c === '+') {
      body.push({ kind: 'new', text: l.slice(1), blank: false });
      j += 1;
    } else if (c === '\\') {
      body.push({ kind: 'slash', text: l, blank: false });
      j += 1;
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1]!.blank) body.pop();
  let lastNoEol = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      lastNoEol = body[k + 1] !== undefined && body[k + 1]!.kind === 'slash';
      break;
    }
  }
  sec.hunks.push({ a, body, lastNoEol });
  return j;
}

function sectionEdit(s: Section, strict: boolean, moves: MovePair[]): Edit {
  return (tree) => {
    const named: string[] = [];
    if (s.oldPath !== null) named.push(s.oldPath);
    if (s.newPath !== null && s.newPath !== s.oldPath) named.push(s.newPath);
    for (const p of named) {
      if (!safe(p)) throw new Fail('unsafe', p);
    }
    const isCreate = s.oldPath === null || s.create;
    if (isCreate) {
      const nw = s.newPath;
      if (nw === null) return;
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (const b of h.body) {
          if (b.kind === 'new') plus.push(b.text);
        }
      }
      let finalBreak = true;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi -= 1) {
        const h = s.hunks[hi]!;
        for (let bi = h.body.length - 1; bi >= 0; bi -= 1) {
          if (h.body[bi]!.kind === 'new') {
            if (h.body[bi + 1] !== undefined && h.body[bi + 1]!.kind === 'slash') finalBreak = false;
            break outer;
          }
        }
      }
      tree.now.set(nw, plus.length === 0 ? '' : plus.join('\n') + (finalBreak ? '\n' : ''));
      return;
    }
    const isDelete = s.newPath === null || s.remove;
    if (isDelete) {
      const old = s.oldPath;
      if (old === null) return;
      if (tree.get(old) === null) throw new Fail('missing', old);
      tree.now.set(old, null);
      return;
    }
    const old = s.oldPath!;
    const cur = tree.get(old);
    if (cur === null) throw new Fail('missing', old);
    const nw = s.newPath;
    const isMove = nw !== null && nw !== old;
    if (isMove && tree.get(nw) !== null) throw new Fail('exists', nw);
    const f = splitFile(cur);
    let lines = f.lines;
    let finalBreak = f.finalBreak;
    let d = 0;
    for (const h of s.hunks) {
      const { oldLines, fresh } = bodyParts(h.body);
      if (oldLines.length > 0) {
        const found = firstTierWith(lines, oldLines, 0, strict);
        if (found === null) throw new Fail('no-match', old);
        const target = h.a - 1 + d;
        let best = found.hits[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of found.hits) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const atEnd = best + oldLines.length === lines.length;
        lines = spliceLines(lines, best, oldLines, fresh, found.tier);
        if (atEnd) finalBreak = !h.lastNoEol;
        d += fresh.length - oldLines.length;
      } else {
        const texts = fresh.map((n) => n.text);
        if (texts.length === 0) continue;
        const at = Math.min(Math.max(h.a + d, 0), lines.length);
        lines = insertLines(lines, at, texts);
        if (at === lines.length) finalBreak = !h.lastNoEol;
        d += texts.length;
      }
    }
    const out = joinFile(lines, f.br, finalBreak);
    if (isMove) {
      tree.now.set(nw!, out);
      tree.now.set(old, null);
      moves.push({ old, nw: nw! });
    } else {
      tree.now.set(old, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: MovePair[]): Edit[] {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s|$)/;
  const sections: Section[] = [];
  let cur: Section | null = null;
  let header = false;
  let i = 0;
  const startSection = (oldP: string | null, newP: string | null): void => {
    cur = { oldPath: oldP, newPath: newP, create: false, remove: false, hasPair: false, hunks: [] };
    sections.push(cur);
    header = true;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const parts = l.trimEnd().split(/\s+/);
      if (parts.length !== 4 || !parts[2]!.startsWith('a/') || !parts[3]!.startsWith('b/') || parts[2]!.length < 3 || parts[3]!.length < 3) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      startSection(parts[2]!.slice(2), parts[3]!.slice(2));
      i += 1;
      continue;
    }
    if (!header && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection(nullPath(headerPath(l)), nullPath(headerPath(lines[i + 1]!)));
      cur!.hasPair = true;
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (header) {
      if (l.startsWith('@@')) {
        const m = hunkRe.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        header = false;
        i = readHunk(lines, i, Number(m[1]), cur);
        continue;
      }
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = nullPath(headerPath(l));
        cur.newPath = nullPath(headerPath(lines[i + 1]!));
        cur.hasPair = true;
        i += 2;
        continue;
      }
      if (l.startsWith('+++ ')) {
        cur.newPath = nullPath(headerPath(l));
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ') && !cur.hasPair) {
        cur.oldPath = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ') && !cur.hasPair) {
        cur.newPath = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.remove = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      i = readHunk(lines, i, Number(m[1]), cur);
      continue;
    }
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict, moves));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: { path: string; oldLines: string[]; newLines: string[] }[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplace; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevReplace = rep;
    prevPath = path;
    i = rep + 1;
  }
  return blocks.map((b) => (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const f = splitFile(cur);
    const found = firstTierWith(f.lines, b.oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.hits.length > 1) throw new Fail('ambiguous', b.path);
    const fresh: NewLine[] = b.newLines.map((t) => ({ ctx: null, text: t }));
    const out = spliceLines(f.lines, found.hits[0]!, b.oldLines, fresh, found.tier);
    tree.now.set(b.path, joinFile(out, f.br, f.finalBreak));
  });
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
  lineNo: number;
}

function v4aSectionStart(l: string): 'add' | 'delete' | 'update' | null {
  if (l.startsWith('*** Add File: ')) return 'add';
  if (l.startsWith('*** Delete File: ')) return 'delete';
  if (l.startsWith('*** Update File: ')) return 'update';
  return null;
}

/** Parse one Add File section starting at `at`; return the section and the line after it. */
function parseV4aAdd(lines: string[], at: number, last: number): { sec: VSection; next: number } {
  const path = lines[at]!.slice(14).trim();
  const entries: { text: string; plus: boolean }[] = [];
  let j = at + 1;
  while (j < last) {
    const l = lines[j]!;
    if (v4aSectionStart(l) !== null) break;
    if (l === '') {
      entries.push({ text: '', plus: false });
      j += 1;
      continue;
    }
    if (l[0] === '+') {
      entries.push({ text: l.slice(1), plus: true });
      j += 1;
      continue;
    }
    throw new Exit2(`error: parse ${j + 1}`);
  }
  while (entries.length > 0 && !entries[entries.length - 1]!.plus && entries[entries.length - 1]!.text === '') entries.pop();
  return { sec: { kind: 'add', path, moveTo: null, addLines: entries.map((e) => e.text), chunks: [], lineNo: at + 1 }, next: j };
}

/** Parse one Delete File section starting at `at`; return the section and the line after it. */
function parseV4aDelete(lines: string[], at: number, last: number): { sec: VSection; next: number } {
  const path = lines[at]!.slice(17).trim();
  let j = at + 1;
  while (j < last) {
    const l = lines[j]!;
    if (v4aSectionStart(l) !== null) break;
    if (l === '') {
      j += 1;
      continue;
    }
    throw new Exit2(`error: parse ${j + 1}`);
  }
  return { sec: { kind: 'delete', path, moveTo: null, addLines: [], chunks: [], lineNo: at + 1 }, next: j };
}

/** Parse one Update File section starting at `at`; return the section and the line after it. */
function parseV4aUpdate(lines: string[], at: number, last: number): { sec: VSection; next: number } {
  const path = lines[at]!.slice(17).trim();
  let j = at + 1;
  let moveTo: string | null = null;
  if (j < last && lines[j]!.startsWith('*** Move to: ')) {
    moveTo = lines[j]!.slice(13).trim();
    j += 1;
  }
  const chunks: VChunk[] = [];
  let current: VChunk | null = null;
  const pushBody = (l: string): void => {
    if (current === null) {
      if (chunks.length > 0) {
        if (l.trim() === '') return;
        throw new Exit2(`error: parse ${j + 1}`);
      }
      current = { anchor: null, body: [], eof: false };
    }
    if (l === '') current.body.push({ kind: 'ctx', text: '', blank: true });
    else if (l[0] === ' ') current.body.push({ kind: 'ctx', text: l.slice(1), blank: false });
    else if (l[0] === '-') current.body.push({ kind: 'old', text: l.slice(1), blank: false });
    else current.body.push({ kind: 'new', text: l.slice(1), blank: false });
  };
  while (j < last) {
    const l = lines[j]!;
    if (v4aSectionStart(l) !== null) break;
    if (l === '*** End of File') {
      if (current === null) throw new Exit2(`error: parse ${j + 1}`);
      current.eof = true;
      chunks.push(current);
      current = null;
      j += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (current !== null) {
        chunks.push(current);
        current = null;
      }
      const at2 = l.slice(2).trim();
      current = { anchor: at2 === '' ? null : at2, body: [], eof: false };
      j += 1;
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      pushBody(l);
      j += 1;
      continue;
    }
    throw new Exit2(`error: parse ${j + 1}`);
  }
  if (current !== null) {
    while (current.body.length > 0) {
      const b = current.body[current.body.length - 1]!;
      if (b.kind === 'ctx' && b.text.trim() === '') current.body.pop();
      else break;
    }
    chunks.push(current);
    current = null;
  }
  const sec: VSection = { kind: 'update', path, moveTo, addLines: [], chunks, lineNo: at + 1 };
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${at + 1}`);
  return { sec, next: j };
}

function v4aEdit(s: VSection, strict: boolean, moves: MovePair[]): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : `${s.addLines.join('\n')}\n`);
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(cur);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const found = firstTierSingle(lines, ch.anchor, cursor, strict);
        if (found === null) throw new Fail('no-match', s.path);
        cursor = found + 1;
      }
      const { oldLines, fresh } = bodyParts(ch.body);
      if (oldLines.length > 0) {
        const tiered = firstTierWith(lines, oldLines, cursor, strict);
        if (tiered === null) throw new Fail('no-match', s.path);
        let pos: number | null = null;
        for (const p of tiered.hits) {
          if (ch.eof && p + oldLines.length !== lines.length) continue;
          pos = p;
          break;
        }
        if (pos === null) throw new Fail('no-match', s.path);
        lines = spliceLines(lines, pos, oldLines, fresh, tiered.tier);
        cursor = pos + fresh.length;
      } else {
        const texts = fresh.map((n) => n.text);
        const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines = insertLines(lines, at, texts);
        cursor = at + texts.length;
      }
    }
    const out = joinFile(lines, f.br, f.finalBreak);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, out);
      tree.now.set(s.path, null);
      moves.push({ old: s.path, nw: s.moveTo });
    } else {
      tree.now.set(s.path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: MovePair[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = v4aSectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const parsed = kind === 'add' ? parseV4aAdd(lines, i, last) : kind === 'delete' ? parseV4aDelete(lines, i, last) : parseV4aUpdate(lines, i, last);
    sections.push(parsed.sec);
    i = parsed.next;
  }
  return sections.map((s) => v4aEdit(s, strict, moves));
}

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
  const moves: MovePair[] = [];
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict, moves) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const m of moves) {
    if (tree.original(m.old) === null || tree.get(m.old) !== null) continue;
    if (tree.original(m.nw) !== null || tree.get(m.nw) === null) continue;
    const di = changed.findIndex((c) => c.text === `D ${m.old}`);
    const ai = changed.findIndex((c) => c.text === `A ${m.nw}`);
    if (di < 0 || ai < 0) continue;
    changed.splice(Math.max(di, ai), 1);
    changed.splice(Math.min(di, ai), 1);
    changed.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.text);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
