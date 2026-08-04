// fetch_titles.mjs — fetch video titles via noembed.com (cached, jittered).
// Only fetches ids missing from video_titles.json, so re-runs are cheap.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'video_titles.json');

const db = fs.readFileSync(path.join(ROOT, 'database'), 'utf8');
const ids = [...new Set([...db.matchAll(/[?&]v=([\w-]+)/g)].map(m => m[1]))];

let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch {}

const todo = ids.filter(id => !cache[id]);
console.log(`videos: ${ids.length}, cached: ${ids.length - todo.length}, to fetch: ${todo.length}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ok = 0, fail = [];
for (const id of todo) {
  try {
    const res = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${id}`);
    const j = await res.json();
    if (j.title) { cache[id] = j.title; ok++; }
    else fail.push(id);
  } catch { fail.push(id); }
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
  await sleep(400 + Math.random() * 400);
}
console.log(`fetched ok: ${ok}, failed: ${fail.length}${fail.length ? ' ' + fail.join(',') : ''}`);
