#!/usr/bin/env node
/**
 * 喵迹 · 本地素材抓取服务 (ingest-server)
 * ------------------------------------------------------------------
 * 用途：你把摄像头导出的照片/视频丢进「投放目录」，本服务自动发现、
 *       压缩/抽帧，前端「素材盒」拉取后走既有 AI 视觉分析链路入库。
 *
 * 特点：
 *   - 零依赖（仅 Node 内置模块），macOS 原生工具做图像处理
 *   - 同时托管前端（同源，规避 HTTPS→http://localhost 的混合内容拦截）
 *   - 图片压缩用 sips；视频抽帧优先 ffmpeg，无 ffmpeg 时降级 qlmanage 取首帧
 *   - 已入库的素材归档到 processed/，不重复处理，原文件永不删除
 *
 * 启动：
 *   node ingest-server.mjs
 *   node ingest-server.mjs --dir ~/喵迹素材 --port 7788 --web ./dist
 *
 * 目录约定（首次启动自动创建）：
 *   ~/喵迹素材/
 *     ├── inbox/        ← 你往这里丢照片/视频
 *     ├── processed/    ← 已入库的素材按日期归档（含 .json 分析留痕）
 *     └── .cache/       ← 抽帧与缩略图缓存（可随时删）
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/* ---------------- 参数 ---------------- */
function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const HOME = os.homedir();
const ROOT = path.resolve(arg('dir', path.join(HOME, '喵迹素材')).replace(/^~/, HOME));
const PORT = parseInt(arg('port', '7788'), 10);
const WEB = path.resolve(arg('web', path.join(process.cwd(), 'dist')));

const INBOX = path.join(ROOT, 'inbox');
const DONE = path.join(ROOT, 'processed');
const CACHE = path.join(ROOT, '.cache');

const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.gif', '.bmp', '.tiff']);
const VID_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.3gp']);

/* ---------------- 工具 ---------------- */
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url');
const dec = (s) => Buffer.from(s, 'base64url').toString('utf8');
const log = (...a) => console.log('[喵迹抓取]', ...a);

async function ensureDirs() {
  for (const d of [ROOT, INBOX, DONE, CACHE]) await fsp.mkdir(d, { recursive: true });
}

async function which(bin) {
  try { const { stdout } = await exec('/usr/bin/which', [bin]); return stdout.trim() || null; }
  catch { return null; }
}
let FFMPEG = null, QLMANAGE = null, SIPS = null;

/** 查找 ffmpeg：--ffmpeg 参数 → PATH → homebrew → imageio-ffmpeg 自带二进制 */
async function findFfmpeg() {
  const custom = arg('ffmpeg', null);
  if (custom && fs.existsSync(custom)) return custom;
  const inPath = await which('ffmpeg');
  if (inPath) return inPath;
  const candidates = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Python 生态里的 imageio-ffmpeg 会自带静态二进制，能用就用
  const globs = [
    path.join(HOME, '.workbuddy/binaries/python/envs/default/lib'),
    path.join(HOME, 'Library/Python'),
  ];
  for (const g of globs) {
    try {
      const stack = [g];
      let depth = 0;
      while (stack.length && depth++ < 4000) {
        const d = stack.pop();
        let ents;
        try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            if (/site-packages|imageio_ffmpeg|binaries|python3\.\d+|lib/.test(e.name)) stack.push(full);
          } else if (/^ffmpeg(-|$)/.test(e.name)) {
            try { await fsp.access(full, fs.constants.X_OK); return full; } catch {}
          }
        }
      }
    } catch {}
  }
  return null;
}

async function probeTools() {
  FFMPEG = await findFfmpeg();
  QLMANAGE = await which('qlmanage');
  SIPS = await which('sips');
  log('工具探测 → ffmpeg:', FFMPEG || '无(视频降级取首帧)', '| sips:', SIPS ? '有' : '无', '| qlmanage:', QLMANAGE ? '有' : '无');
}

/** 按文件名猜测最可能的分析类型，前端可改 */
function guessType(name) {
  const n = name.toLowerCase();
  const rules = [
    [/(food|meal|eat|吃|饭|碗|粮|喂)/, 'food'],
    [/(stool|poop|litter|shit|便|屎|排泄|猫砂)/, 'stool'],
    [/(skin|fur|hair|皮|毛|癣|秃)/, 'skin'],
    [/(wound|injur|hurt|伤|肿|块)/, 'wound'],
    [/(med|pill|drug|药)/, 'med'],
    [/(env|room|home|环境|家)/, 'environment'],
    [/(body|weight|胖|瘦|体态|称)/, 'body'],
  ];
  for (const [re, t] of rules) if (re.test(n)) return t;
  return 'behavior';
}

/* ---------------- 图像处理（macOS 原生） ---------------- */
/** 用 sips 压到 maxPx 内并转 JPEG，返回 dataURL */
async function toJpegDataURL(file, maxPx = 800, quality = 'normal') {
  const out = path.join(CACHE, 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.jpg');
  try {
    if (SIPS) {
      await exec(SIPS, ['-Z', String(maxPx), '-s', 'format', 'jpeg', '-s', 'formatOptions', quality, file, '--out', out]);
      const b = await fsp.readFile(out);
      fsp.unlink(out).catch(() => {});
      return 'data:image/jpeg;base64,' + b.toString('base64');
    }
  } catch (e) { log('sips 处理失败，回退原图：', path.basename(file), e.message); }
  // 无 sips 或失败：直接读原文件（体积可能较大）
  const b = await fsp.readFile(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,` + b.toString('base64');
}

/**
 * 视频抽帧。
 * 有 ffmpeg：按 count 均匀抽帧（默认 3 帧：开头/中间/结尾附近）
 * 无 ffmpeg：qlmanage 取首帧（Quick Look 缩略图，macOS 自带）
 */
async function extractFrames(file, count = 3) {
  const base = path.join(CACHE, 'f_' + enc(path.basename(file)).slice(0, 24));
  const frames = [];
  if (FFMPEG) {
    let dur = 0;
    try {
      const { stdout } = await exec(FFMPEG, ['-i', file], { encoding: 'utf8' }).catch(e => ({ stdout: (e.stderr || '') }));
      const m = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(stdout || '');
      if (m) dur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
    } catch {}
    const pts = dur > 1
      ? Array.from({ length: count }, (_, i) => (dur * (i + 1)) / (count + 1))
      : [0];
    for (let i = 0; i < pts.length; i++) {
      const out = `${base}_${i}.jpg`;
      try {
        await exec(FFMPEG, ['-y', '-ss', pts[i].toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=800:-2', '-q:v', '4', out]);
        if (fs.existsSync(out)) frames.push(out);
      } catch (e) { log('抽帧失败 @', pts[i], e.message); }
    }
  }
  if (!frames.length && QLMANAGE) {
    try {
      await exec(QLMANAGE, ['-t', '-s', '800', '-o', CACHE, file]);
      const guess = path.join(CACHE, path.basename(file) + '.png');
      if (fs.existsSync(guess)) frames.push(guess);
    } catch (e) { log('qlmanage 取帧失败：', e.message); }
  }
  return frames;
}

/* ---------------- 扫描 ---------------- */
let INDEX = new Map(); // id -> item

async function scan() {
  await ensureDirs();
  const items = new Map();
  let names;
  try { names = await fsp.readdir(INBOX); } catch { names = []; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(INBOX, name);
    let st;
    try { st = await fsp.stat(full); } catch { continue; }
    if (!st.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    const kind = IMG_EXT.has(ext) ? 'image' : VID_EXT.has(ext) ? 'video' : null;
    if (!kind) continue;
    // 跳过正在写入的文件（大小 0）
    if (st.size === 0) continue;
    const id = enc(name);
    const prev = INDEX.get(id);
    items.set(id, prev && prev.mtime === st.mtimeMs ? prev : {
      id, name, kind, size: st.size, mtime: st.mtimeMs,
      guess: guessType(name),
      addedAt: prev ? prev.addedAt : Date.now(),
      frames: null,   // 视频抽帧结果，懒加载
      thumb: null,    // 缩略图 dataURL 缓存，懒加载
    });
  }
  INDEX = items;
  return INDEX;
}

async function getItem(id) {
  if (!INDEX.has(id)) await scan();
  return INDEX.get(id) || null;
}

async function itemFrames(it) {
  if (it.kind === 'image') return [path.join(INBOX, it.name)];
  if (!it.frames) it.frames = await extractFrames(path.join(INBOX, it.name));
  return it.frames;
}

/* ---------------- 归档 ---------------- */
async function archive(id, payload, skipped = false) {
  const it = await getItem(id);
  if (!it) throw new Error('素材不存在或已处理：' + id);
  const day = new Date().toISOString().slice(0, 10);
  const dir = skipped ? path.join(DONE, 'skipped') : path.join(DONE, day);
  await fsp.mkdir(dir, { recursive: true });
  let target = path.join(dir, it.name);
  let n = 1;
  while (fs.existsSync(target)) {
    const e = path.extname(it.name), b = path.basename(it.name, e);
    target = path.join(dir, `${b}_${n++}${e}`);
  }
  await fsp.rename(path.join(INBOX, it.name), target);
  if (!skipped) {
    // 分析留痕（可审计）
    await fsp.writeFile(target + '.json', JSON.stringify({
      source: it.name, archivedAt: new Date().toISOString(),
      kind: it.kind, guessType: it.guess, ...payload,
    }, null, 2), 'utf8');
  }
  INDEX.delete(id);
  // 清理该素材的帧缓存
  if (it.frames) for (const f of it.frames) fsp.unlink(f).catch(() => {});
  return path.relative(ROOT, target);
}

/* ---------------- HTTP ---------------- */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 30e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(WEB, rel);
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const st = await fsp.stat(file);
    if (st.isDirectory()) throw new Error('dir');
    const b = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(b);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 · 未找到 ' + rel + '\n（前端目录：' + WEB + '）');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  try {
    /* --- 抓取 API --- */
    if (p === '/ingest/health') {
      await scan();
      return json(res, {
        ok: true, service: '喵迹本地素材抓取', dir: ROOT, inbox: INBOX,
        pending: INDEX.size, ffmpeg: !!FFMPEG, sips: !!SIPS, ql: !!QLMANAGE,
      });
    }

    if (p === '/ingest/list') {
      await scan();
      const items = [...INDEX.values()]
        .sort((a, b) => b.mtime - a.mtime)
        .map(({ id, name, kind, size, mtime, guess }) => ({
          id, name, kind, size, mtime,
          sizeText: size > 1048576 ? (size / 1048576).toFixed(1) + 'MB' : Math.round(size / 1024) + 'KB',
          guess,
        }));
      return json(res, { items, dir: ROOT, pending: items.length });
    }

    if (p === '/ingest/thumb') {
      const it = await getItem(url.searchParams.get('id'));
      if (!it) return json(res, { error: 'not found' }, 404);
      if (!it.thumb) {
        const fr = await itemFrames(it);
        it.thumb = fr.length ? await toJpegDataURL(fr[0], 240, 'low') : null;
      }
      return json(res, { image: it.thumb });
    }

    if (p === '/ingest/payload') {
      const it = await getItem(url.searchParams.get('id'));
      if (!it) return json(res, { error: 'not found' }, 404);
      const idx = parseInt(url.searchParams.get('frame') || '0', 10);
      const fr = await itemFrames(it);
      if (!fr.length) return json(res, { error: '无法从该素材取帧' + (it.kind === 'video' && !FFMPEG ? '（未装 ffmpeg，视频仅能取首帧；brew install ffmpeg 可抽多帧）' : '') }, 422);
      const pick = fr[Math.min(Math.max(idx, 0), fr.length - 1)];
      const image = await toJpegDataURL(pick, 800, 'normal');
      return json(res, { image, frameCount: fr.length, frame: idx, name: it.name, kind: it.kind, guess: it.guess });
    }

    if (p === '/ingest/ack' && req.method === 'POST') {
      const b = await readBody(req);
      const to = await archive(b.id, { result: b.result || null, recordType: b.recordType || null, note: b.note || '' });
      return json(res, { ok: true, archived: to, pending: INDEX.size });
    }

    if (p === '/ingest/skip' && req.method === 'POST') {
      const b = await readBody(req);
      const to = await archive(b.id, {}, true);
      return json(res, { ok: true, archived: to, pending: INDEX.size });
    }

    if (p === '/ingest/open') { // 便捷：在 Finder 中打开投放目录
      exec('/usr/bin/open', [INBOX]).catch(() => {});
      return json(res, { ok: true, opened: INBOX });
    }

    /* --- 静态前端（同源，避免混合内容拦截） --- */
    return await serveStatic(req, res, p);
  } catch (e) {
    return json(res, { error: e.message || String(e) }, 500);
  }
});

/* ---------------- 启动 ---------------- */
await ensureDirs();
await probeTools();
await scan();

// fs.watch 实时感知 + 20s 轮询兜底（网络盘/同步盘 watch 可能失效）
try {
  fs.watch(INBOX, { persistent: false }, () => { scan().catch(() => {}); });
} catch (e) { log('watch 不可用，仅用轮询：', e.message); }
setInterval(() => { scan().catch(() => {}); }, 20000);

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets).flat().find(n => n && n.family === 'IPv4' && !n.internal);
  log('已启动');
  log('  投放目录  →', INBOX, '（把照片/视频丢进这里）');
  log('  归档目录  →', DONE);
  log('  前端目录  →', WEB);
  log('  本机访问  → http://localhost:' + PORT);
  if (lan) log('  手机访问  → http://' + lan.address + ':' + PORT + '（需同一 Wi-Fi）');
  log('  当前待处理素材：', INDEX.size, '个');
  if (!FFMPEG) log('  提示：未装 ffmpeg，视频只能取首帧。执行 brew install ffmpeg 可启用多帧抽样。');
});
