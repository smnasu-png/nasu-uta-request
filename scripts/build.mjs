// build.mjs — parse the nasu-utamita `database` file into deduplicated song groups.
// Usage: node scripts/build.mjs [path-to-database]
// Emits: site/data.js (window.SONG_DATA), site/songs.csv, prints stats + runs assertions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DB_PATH = process.argv[2] || path.join(ROOT, 'database');
const TITLE_CACHE_PATH = path.join(ROOT, 'video_titles.json');

const raw = fs.readFileSync(DB_PATH, 'utf8');
const lines = raw.split('\n').map(l => l.replace(/[​﻿]/g, ''));

// ---------------------------------------------------------------
// Fix maps (explicit, hand-curated from reading the whole database)
// ---------------------------------------------------------------
// Applied to the full raw title text BEFORE any splitting.
const RAW_FIXES = new Map([
  ['ヒャダイン のカカカタ☆カタオモイ-c', 'ヒャダインのカカカタ☆カタオモイ'],
  ['青いベンチ-10th Anniveersary-', '青いベンチ(10th Anniversary ver)'],
  ['ｰ救世主 メシアｰ', '救世主メシア'],
  ['轍～わだち～', '轍'],
  ['猫 DISH//', '猫/DISH//'],
  ['K/BUMP OF CHICKEN', 'K / BUMP OF CHICKEN'],
]);

// Applied to the title part AFTER artist splitting.
const TITLE_FIXES = new Map([
  ['めざぜポケモンマスター', 'めざせポケモンマスター'],
  ['ETERNAK BLAZE', 'ETERNAL BLAZE'],
  ['DAN DAN 心魅かれてく', 'DAN DAN 心惹かれてく'],
  ['真夏の世の夢', '真夏の夜の夢'],
  ['小さな恋の歌', '小さな恋のうた'],
  ['きまぐれロマンティック', '気まぐれロマンティック'],
  ['激!帝 ～最終章～', '檄！帝～最終章～'],
  ['激！帝 ～最終章～', '檄！帝～最終章～'],
  ['葛飾ラプソディ', '葛飾ラプソディー'],
  ['DISCO THE QUE', 'DISCOTHEQUE'],
  ['ラフ・メイカー', 'ラフメイカー'],
  ['フォニィ', 'フォニイ'],
  ['限界突破✕サバイバー', '限界突破×サバイバー'],
]);

const ARTIST_FIXES = new Map([
  ['THE BLUE HARTS', 'THE BLUE HEARTS'],
  ['janne da arc', 'Janne Da Arc'],
  ['janne Da Arc', 'Janne Da Arc'],
  ['Janne da arc', 'Janne Da Arc'],
  ['JANNE DA ARC', 'Janne Da Arc'],
  ['Deco27', 'DECO*27'],
  ['Deco*27', 'DECO*27'],
  ['deco27', 'DECO*27'],
  ['DECO27', 'DECO*27'],
  ['creepy nuts', 'Creepy Nuts'],
  ['superfly', 'Superfly'],
  ['Jam project', 'JAM Project'],
  ['XJAPAN', 'X JAPAN'],
  ['Supercell', 'supercell'],
  ['DISH', 'DISH//'],
]);

// Segment labels in the database that are not songs.
const NOT_SONGS = new Set(['待機時間', '音域テスト', '下ネタ']);

// Paren contents that are performance notes (kept as note), not part of the title.
const NOTE_RE = /(アカペラ|番のみ|番だけ|^1番$|うろ覚え|ボイチェン|ver|速度|主題歌|^恥$|ｸﾞﾀﾞ|がなり|フル|サビ)/i;

const KEY_ALIASES = new Map([
  ['激帝最終章', '檄帝最終章'],
  ['フォニィ', 'フォニイ'],
  ['魔弾derfreischutz', '魔弾'],
]);

// ---------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------
const streams = [];   // { id, url, vc, takes: [] } — timestamped 歌枠
const pending = [];   // { id, url, vc } — 歌枠 with no timestamps yet
const mvs = [];       // { id, url }
let section = null;
let cur = null;
let tsLineCount = 0;
let excluded = [];
let inStreamDupes = [];

const vid = u => (u.match(/[?&]v=([^&\s]+)/) || [])[1] || null;
const TS_RE = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*(.+)$/;

for (const rawLine of lines) {
  const line = rawLine.trim();
  if (!line) continue;
  if (line.includes('タイムスタンプ準備中')) { section = 'pending'; cur = null; continue; }
  if (line === '■Music Video') { section = 'mv'; cur = null; continue; }
  if (line === '■歌ってみた枠') { section = 'live'; cur = null; continue; }

  if (line.startsWith('https://')) {
    const id = vid(line);
    if (!id) throw new Error('URL without video id: ' + line);
    if (section === 'mv') mvs.push({ id, url: line });
    else if (section === 'pending') pending.push({ id, url: line, vc: false });
    else if (section === 'live') { cur = { id, url: line, vc: false, takes: [] }; streams.push(cur); }
    continue;
  }

  if (line === 'ボイチェン') {
    if (section === 'live' && cur) cur.vc = true;
    else if (section === 'pending' && pending.length) pending[pending.length - 1].vc = true;
    continue;
  }

  if (section === 'live' && cur) {
    const m = TS_RE.exec(line);
    if (!m) { console.warn('UNPARSED live line:', JSON.stringify(line)); continue; }
    tsLineCount++;
    const take = parseTake(m[1], m[2], cur);
    if (take === 'excluded') { excluded.push(line); continue; }
    // de-dupe identical (same stream, same seconds, same key) entries
    if (cur.takes.some(t => t.sec === take.sec && t.key === take.key)) {
      inStreamDupes.push(line); continue;
    }
    cur.takes.push(take);
  }
}

function tsToSec(ts) {
  const p = ts.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

function parseTake(ts, rawTitle, stream) {
  let t = rawTitle.trim();
  let rec = false;
  let notes = [];

  // recommend marker (🍆＜おすすめ！ etc.) — anything from the first emoji onward
  if (/🍆/.test(t)) rec = true;
  t = t.replace(/[🍆🌸✨💫⭐🎵🎶🎤]+.*$/u, '').replace(/＜.*$/u, '').trim();

  if (RAW_FIXES.has(t)) t = RAW_FIXES.get(t);
  if (NOT_SONGS.has(t)) return 'excluded';

  // prefix paren note e.g. (恥)粛聖★ロリ神レクイエム
  const pre = t.match(/^[（(]([^）)]{1,8})[）)]\s*(.+)$/);
  if (pre && NOTE_RE.test(pre[1])) { notes.push(pre[1]); t = pre[2]; }

  // trailing " #2" marker
  t = t.replace(/\s*#\d+$/, '');

  // artist split: ／ first, then " / ", then guarded bare "/", then " - "
  let artist = null;
  const trySplit = (idx, sepLen) => {
    const left = t.slice(0, idx).trim();
    const right = t.slice(idx + sepLen).trim();
    if (!left || !right) return false;
    t = left; artist = right; return true;
  };
  let i;
  if ((i = t.indexOf('／')) >= 0) trySplit(i, 1);
  else if ((i = t.indexOf(' / ')) >= 0) trySplit(i, 3);
  else if ((i = t.indexOf('/')) >= 0) {
    const left = t.slice(0, i).trim();
    const guard = left.length >= 2 || (left.length === 1 && /[぀-鿿]/.test(left));
    if (guard && !/^\d+$/.test(left) && t.slice(i + 1).trim().length >= 2) trySplit(i, 1);
  } else if ((i = t.indexOf(' - ')) >= 0) trySplit(i, 3);

  // trailing paren: note if it matches NOTE_RE, artist if latin-ish and no artist yet
  const tail = t.match(/^(.+?)\s*[（(]([^（）()]{1,25})[）)]$/);
  if (tail) {
    if (NOTE_RE.test(tail[2])) { notes.push(tail[2]); t = tail[1].trim(); }
    else if (!artist && /^[A-Za-z0-9 .,'&★☆!-]+$/.test(tail[2])) { artist = tail[2]; t = tail[1].trim(); }
  }
  if (artist) {
    // strip note-parens inside artist e.g. THE BLUE HARTS（“がなり”控え目ver）
    const am = artist.match(/^(.+?)\s*[（(]([^（）()]{1,25})[）)]$/);
    if (am && NOTE_RE.test(am[2])) { notes.push(am[2]); artist = am[1].trim(); }
    artist = artist.replace(/\s*#\d+$/, '').trim();
    if (ARTIST_FIXES.has(artist)) artist = ARTIST_FIXES.get(artist);
  }

  if (TITLE_FIXES.has(t)) t = TITLE_FIXES.get(t);
  t = t.trim();
  if (!t) throw new Error('empty title from: ' + rawTitle);

  return {
    streamId: stream.id, ts, sec: tsToSec(ts), vc: stream.vc,
    title: t, artist, rec, note: notes.join('・') || null,
    key: canonKey(t),
  };
}

// canonical grouping key
function canonKey(title) {
  let k = title.normalize('NFKC').toLowerCase();
  k = k.replace(/[〜～~]/g, '');
  k = k.replace(/[\s　]/g, '');
  k = k.replace(/[、。，,．.・…:;'’"”“!?！?？☆★✕×☓‐‑–—\-ー]/g, '');
  k = k.replace(/[（）()［］\[\]『』「」]/g, '');
  if (KEY_ALIASES.has(k)) k = KEY_ALIASES.get(k);
  return k;
}

// ---------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------
const groups = new Map();
for (const s of streams) {
  for (const take of s.takes) {
    if (!groups.has(take.key)) groups.set(take.key, { key: take.key, takes: [] });
    groups.get(take.key).takes.push(take);
  }
}

const ARTIST_DISPLAY_OVERRIDES = new Map([
  [canonKey('ヴァンパイア'), 'DECO*27 ／ Janne Da Arc（同名の別曲・どちらも歌唱歴あり）'],
]);
const MULTI_ARTIST_KEYS = new Set([canonKey('ヴァンパイア')]);

const songs = [...groups.values()].map(g => {
  // display title: most frequent variant; tie → longest
  const freq = new Map();
  for (const t of g.takes) freq.set(t.title, (freq.get(t.title) || 0) + 1);
  const title = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];

  // artist: most frequent non-null; tie → longest
  const af = new Map();
  for (const t of g.takes) if (t.artist) af.set(t.artist, (af.get(t.artist) || 0) + 1);
  let artist = af.size ? [...af.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0] : null;
  let artistList = [artist].filter(Boolean);
  if (ARTIST_DISPLAY_OVERRIDES.has(g.key)) {
    artist = ARTIST_DISPLAY_OVERRIDES.get(g.key);
    artistList = ['DECO*27', 'Janne Da Arc'];
  }

  return {
    key: g.key, title, artist, artistList,
    count: g.takes.length,
    rec: g.takes.some(t => t.rec),
    vcOnly: g.takes.every(t => t.vc),
    takes: g.takes.map(t => ({
      streamId: t.streamId, ts: t.ts, sec: t.sec, vc: t.vc,
      note: t.note, rec: t.rec, artist: t.artist,
    })),
  };
});
songs.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'ja'));

// ---------------------------------------------------------------
// Assertions — fail loudly rather than publish wrong data
// ---------------------------------------------------------------
const takesTotal = songs.reduce((n, s) => n + s.count, 0);
const errors = [];
const assert = (cond, msg) => { if (!cond) errors.push(msg); };

assert(tsLineCount === takesTotal + excluded.length + inStreamDupes.length,
  `accounting mismatch: tsLines=${tsLineCount} takes=${takesTotal} excluded=${excluded.length} dupes=${inStreamDupes.length}`);
assert(mvs.length === 4, `expected 4 MVs, got ${mvs.length}`);
assert(pending.length === 14, `expected 14 pending streams, got ${pending.length}`);
assert(streams.length > 40, `expected >40 timestamped streams, got ${streams.length}`);
assert(songs.every(s => s.title.length > 0), 'empty song title found');
const vamp = songs.find(s => s.key === canonKey('ヴァンパイア'));
assert(vamp && vamp.artistList.length === 2, 'vampire group should carry both artists');
const recTotal = songs.reduce((n, s) => n + s.takes.filter(t => t.rec).length, 0);
assert(recTotal === 5, `expected 5 🍆おすすめ takes, got ${recTotal}`);
assert(new Set(songs.map(s => s.key)).size === songs.length, 'duplicate group keys');
// every stream contributed
const usedStreams = new Set(songs.flatMap(s => s.takes.map(t => t.streamId)));
for (const s of streams) assert(usedStreams.has(s.id) || s.takes.length === 0, `stream ${s.id} lost all takes`);

// near-miss detector: warn about pairs of keys at edit distance 1 (possible missed merges)
function lev1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length === b.length) { i++; j++; }
    else if (a.length > b.length) i++;
    else j++;
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
const keys = songs.map(s => s.key);
const nearMisses = [];
for (let i = 0; i < keys.length; i++)
  for (let j = i + 1; j < keys.length; j++)
    if (lev1(keys[i], keys[j])) nearMisses.push(`${songs[i].title}  ~  ${songs[j].title}`);

// ---------------------------------------------------------------
// Output
// ---------------------------------------------------------------
let titleCache = {};
try { titleCache = JSON.parse(fs.readFileSync(TITLE_CACHE_PATH, 'utf8')); } catch {}

const data = {
  generatedAt: new Date().toISOString().slice(0, 10),
  stats: { songs: songs.length, takes: takesTotal, streams: streams.length, pending: pending.length },
  streams: streams.map(s => ({ id: s.id, vc: s.vc, title: titleCache[s.id] || null })),
  pending: pending.map(p => ({ id: p.id, vc: p.vc, title: titleCache[p.id] || null })),
  mvs: mvs.map(m => ({ id: m.id, title: titleCache[m.id] || null })),
  songs,
};


fs.writeFileSync(path.join(ROOT, 'data.js'),
  'window.SONG_DATA = ' + JSON.stringify(data) + ';\n');

// CSV (Excel-friendly BOM; one row per unique song)
const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const csvRows = [['曲名', 'アーティスト', '歌った回数', 'おすすめ', '歌唱例リンク'].map(esc).join(',')];
for (const s of songs) {
  const last = s.takes[s.takes.length - 1];
  csvRows.push([s.title, s.artist || '', s.count, s.rec ? '🍆' : '',
    `https://www.youtube.com/watch?v=${last.streamId}&t=${last.sec}s`].map(esc).join(','));
}
fs.writeFileSync(path.join(ROOT, 'songs.csv'), '﻿' + csvRows.join('\r\n'));

// ---------------------------------------------------------------
// Report
// ---------------------------------------------------------------
console.log(`streams(timestamped): ${streams.length}`);
console.log(`pending streams:      ${pending.length}`);
console.log(`MVs:                  ${mvs.length}`);
console.log(`timestamp lines:      ${tsLineCount}`);
console.log(`takes kept:           ${takesTotal}`);
console.log(`excluded (not songs): ${excluded.length}  ${JSON.stringify(excluded)}`);
console.log(`in-stream dupes:      ${inStreamDupes.length}  ${JSON.stringify(inStreamDupes)}`);
console.log(`unique songs:         ${songs.length}`);
console.log(`🍆 recommended takes:  ${recTotal}`);
console.log('--- top 15 by count ---');
for (const s of songs.slice(0, 15)) console.log(`  ${String(s.count).padStart(2)}x ${s.title}${s.artist ? ' / ' + s.artist : ''}`);
if (nearMisses.length) {
  console.log('--- NEAR-MISS key pairs (review manually) ---');
  nearMisses.forEach(p => console.log('  ' + p));
}
if (errors.length) {
  console.error('\nASSERTION FAILURES:');
  errors.forEach(e => console.error('  ✗ ' + e));
  process.exit(1);
}
console.log('\nALL ASSERTIONS PASSED');
