import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const config = JSON.parse(readFileSync(process.env.PORTAL_CONFIG));
const db = new DatabaseSync(config.database);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS roots (
    id TEXT PRIMARY KEY, device TEXT NOT NULL, name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    root TEXT NOT NULL REFERENCES roots(id) ON DELETE CASCADE,
    path TEXT NOT NULL, parent TEXT NOT NULL, name TEXT NOT NULL,
    folder INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
    PRIMARY KEY (root,path)
  );
  CREATE INDEX IF NOT EXISTS by_parent ON entries(root,parent,folder DESC,name COLLATE NOCASE,path);
  CREATE TABLE IF NOT EXISTS root_registrations (
    root TEXT PRIMARY KEY REFERENCES roots(id) ON DELETE CASCADE,
    revision TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS revoked_registrations (
    root TEXT NOT NULL, device TEXT NOT NULL, revision TEXT NOT NULL,
    PRIMARY KEY (device,root,revision)
  );
`);
const sql = Object.fromEntries(Object.entries({
  roots: 'SELECT id,device,name FROM roots ORDER BY name COLLATE NOCASE',
  root: 'SELECT id,device,name FROM roots WHERE id=? AND device=?',
  owner: 'SELECT id,device,name FROM roots WHERE id=?',
  save: 'INSERT INTO roots VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE device=excluded.device',
  remove: 'DELETE FROM roots WHERE id=? AND device=?',
  registration: 'SELECT revision FROM root_registrations WHERE root=?',
  saveRegistration: 'INSERT OR REPLACE INTO root_registrations VALUES (?,?)',
  revoke: 'INSERT OR IGNORE INTO revoked_registrations VALUES (?,?,?)',
  isRevoked: 'SELECT 1 FROM revoked_registrations WHERE root=? AND device=? AND revision=?',
  revoked: 'SELECT root,revision FROM revoked_registrations WHERE device=?',
  previous: 'SELECT path,folder FROM entries WHERE root=? AND parent=?',
  entry: 'SELECT folder,name FROM entries WHERE root=? AND path=?',
  put: 'INSERT OR REPLACE INTO entries VALUES (?,?,?,?,?,?,?)',
  subtree: 'DELETE FROM entries WHERE root=? AND (path=? OR (path>=? AND path<?))',
}).map(([key, statement]) => [key, db.prepare(statement)]));

const fileTypes = Object.fromEntries([
  ['文本文档', 'txt log'], ['PDF 文件', 'pdf'], ['Markdown 源文件', 'md markdown'],
  ['Python 源文件', 'py pyw'], ['JavaScript 文件', 'js mjs cjs'], ['TypeScript 文件', 'ts tsx'],
  ['HTML 文档', 'htm html'], ['CSS 文件', 'css'], ['PowerShell 脚本', 'ps1'],
  ['图片文件', 'jpg jpeg png gif webp avif bmp heic heif tif tiff svg ico'],
  ['视频文件', 'mp4 mov m4v webm avi mkv'], ['音频文件', 'mp3 m4a wav flac ogg'],
  ['Word 文档', 'doc docx'], ['Excel 工作表', 'xls xlsx'], ['PowerPoint 演示文稿', 'ppt pptx'],
  ['压缩文件', 'zip rar 7z gz tar'],
].flatMap(([type, extensions]) => extensions.split(' ').map(extension => [extension, type])));
db.function('file_type', { deterministic: true }, (name, folder) => {
  if (folder) return '文件夹';
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (Object.hasOwn(fileTypes, extension)) return fileTypes[extension];
  return extension && extension.length <= 20 ? extension.toUpperCase() + ' 文件' : '文件';
});
const children = new Map(Object.entries({
  name: 'name COLLATE NOCASE', mtime: 'mtime', type: 'type COLLATE NOCASE', size: 'size',
}).flatMap(([key, column]) => ['asc', 'desc'].map(direction => [
  key + '-' + direction,
  db.prepare(`SELECT path,name,folder,size,mtime,file_type(name,folder) AS type
    FROM entries WHERE root=? AND parent=? AND (?='' OR instr(lower(name),lower(?))>0)
    ORDER BY folder DESC,${column} ${direction},name COLLATE NOCASE,path LIMIT 201 OFFSET ?`),
])));

const base = '/files/';
const devices = new Map([
  { id: config.device, name: config.deviceName, hash: config.agentHash },
  ...(config.additionalDevices ?? []),
].map(device => [device.id, { ...device, queue: [], waiter: undefined, seen: 0 }]));
const sessions = new Map();
const transfers = new Map();
let failures = 0;
let resetFailures = 0;
const previews = {
  jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif',
  webp:'image/webp', avif:'image/avif', bmp:'image/bmp', heic:'image/heic',
  mp4:'video/mp4', mov:'video/quicktime', m4v:'video/mp4', webm:'video/webm',
  mp3:'audio/mpeg', m4a:'audio/mp4', wav:'audio/wav', ogg:'audio/ogg', pdf:'application/pdf',
};
const plaintext = new Set('txt md markdown csv tsv json yaml yml xml html css js ts py ps1 sh log ini toml r tex bib sql'.split(' '));
const uuid = /^[0-9a-f]{32}$/;
const digest = value => createHash('sha256').update(value).digest();
const check = (value, hash) => timingSafeEqual(digest(value), Buffer.from(hash, 'hex'));
const segment = name => typeof name === 'string' && name.length > 0 &&
  name.length <= 255 && name !== '.' && name !== '..' && !/[\\/:\u0000-\u001f]/.test(name);
const validPath = path => typeof path === 'string' && path.length <= 32000 &&
  (path === '' || path.split('/').every(segment));
const online = device => Boolean(device && Date.now() - device.seen < 25000);
const setCookie = (value, lifetime) =>
  `__Secure-fileportal=${value}; Path=${base}; Secure; HttpOnly; SameSite=Strict; Max-Age=${lifetime}`;
const response = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
};
const error = (res, status, message) => response(res, status, { error: message });
async function body(req, max = 12 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function index(data, device) {
  const revision = data.revision ?? '';
  if (!uuid.test(data.id) || (revision !== '' && (typeof revision !== 'string' || !uuid.test(revision))) ||
      typeof data.name !== 'string' ||
      !data.name.trim() || data.name.length > 255 || !Array.isArray(data.dirs)) {
    throw Object.assign(new Error('Invalid root'), { status: 400 });
  }
  if (sql.isRevoked.get(data.id, device.id, revision)) return { revoked: true };
  for (const { path, entries } of data.dirs) {
    if (!validPath(path) || !Array.isArray(entries) || entries.some(item =>
      !segment(item.name) || typeof item.folder !== 'boolean' ||
      !Number.isSafeInteger(item.size) || item.size < 0 || !Number.isSafeInteger(item.mtime))) {
      throw Object.assign(new Error('Invalid entries'), { status: 400 });
    }
  }
  db.exec('BEGIN');
  try {
    sql.save.run(data.id, device.id, data.name);
    if (!sql.root.get(data.id, device.id)) {
      throw Object.assign(new Error('Root belongs to another device'), { status: 403 });
    }
    sql.saveRegistration.run(data.id, revision);
    for (const { path, entries } of data.dirs) {
      if (path && !sql.entry.get(data.id, path)?.folder) continue;
      const prefix = path ? path + '/' : '';
      const current = new Map(entries.map(item => [prefix + item.name, item]));
      for (const old of sql.previous.all(data.id, path)) {
        if (current.get(old.path)?.folder !== Boolean(old.folder)) {
          sql.subtree.run(data.id, old.path, old.path + '/', old.path + '0');
        }
      }
      for (const [child, item] of current) {
        sql.put.run(data.id, child, path, item.name, Number(item.folder), item.size, item.mtime);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

function unshare(root) {
  const record = sql.owner.get(root);
  if (!record) return;
  db.exec('BEGIN');
  try {
    sql.revoke.run(root, record.device, sql.registration.get(root)?.revision ?? '');
    sql.remove.run(root, record.device);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  for (const job of transfers.values()) {
    if (job.request.root !== root) continue;
    clearTimeout(job.timer);
    if (job.res.headersSent) job.res.destroy();
    else error(job.res, 404, '此目录已移除查看。');
  }
}

function poll(res, device) {
  device.seen = Date.now();
  while (device.queue.length) {
    const id = device.queue.shift();
    if (transfers.has(id)) return response(res, 200, transfers.get(id).request);
  }
  if (device.waiter) device.waiter(null);
  const complete = request => {
    clearTimeout(timer);
    if (device.waiter === complete) device.waiter = undefined;
    if (!res.destroyed) response(res, 200, request);
  };
  const timer = setTimeout(() => complete(null), 12000);
  res.once('close', () => {
    clearTimeout(timer);
    if (device.waiter === complete) device.waiter = undefined;
  });
  device.waiter = complete;
}

function requestFile(req, res, root, path, preview) {
  const entry = sql.entry.get(root, path);
  if (!entry || entry.folder) return error(res, 404, '找不到文件，请刷新目录。');
  const device = devices.get(sql.owner.get(root)?.device);
  if (!online(device)) return error(res, 503, '电脑离线，仍可浏览上次保存的目录。');
  if ([...transfers.values()].filter(job => job.device === device.id).length >= 12) {
    return error(res, 429, '当前文件请求较多，请稍后重试。');
  }
  const extension = entry.name.split('.').pop().toLowerCase();
  const type = preview && (Object.hasOwn(previews, extension) ? previews[extension] :
      (plaintext.has(extension) && 'text/plain; charset=utf-8'));
  const range = req.headers.range ?? '';
  if (range && !/^bytes=(?:\d{1,15}-\d{0,15}|-\d{1,15})$/.test(range)) {
    return error(res, 416, '不支持此文件范围。');
  }
  const id = randomBytes(16).toString('hex');
  const timer = setTimeout(() => error(res, 504, '等待电脑响应超时。'), 20000);
  transfers.set(id, { res, timer, type, name: entry.name, device: device.id, request: { id, root, path, range } });
  res.once('close', () => {
    clearTimeout(timer);
    const upload = transfers.get(id)?.upload;
    if (upload && !upload.complete) upload.destroy();
    transfers.delete(id);
    const position = device.queue.indexOf(id);
    if (position >= 0) device.queue.splice(position, 1);
  });
  if (device.waiter) device.waiter(transfers.get(id).request);
  else device.queue.push(id);
}

function relay(req, res, id, device) {
  const job = transfers.get(id);
  if (!job || job.upload || job.res.writableEnded || job.res.destroyed) return error(res, 410, 'Request expired');
  if (job.device !== device.id) return error(res, 403, 'Wrong device');
  const status = Number(req.headers['x-file-status']);
  const length = req.headers['content-length'];
  const range = req.headers['x-file-range'];
  if (![200, 206, 404, 409, 416, 503].includes(status) ||
      !/^\d{1,16}$/.test(length ?? '') ||
      (status === 206 && !/^bytes \d+-\d+\/\d+$/.test(range ?? '')) ||
      (status === 416 && !/^bytes \*\/\d+$/.test(range ?? ''))) return error(res, 400, 'Invalid stream headers');
  clearTimeout(job.timer);
  if (status >= 400) {
    if (status === 416) job.res.setHeader('Content-Range', range);
    error(job.res, status, status === 416 ? '请求范围超出文件大小。' : '电脑暂时无法读取该文件，请刷新后重试。');
    return response(res, 200, true);
  }
  const filename = encodeURIComponent(job.name).replace(/['()*]/g, char =>
    '%' + char.charCodeAt(0).toString(16).toUpperCase());
  job.res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  job.res.writeHead(status, {
    'Content-Type': job.type || 'application/octet-stream',
    'Content-Disposition': `${job.type ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`,
    'Content-Length': length,
    'Accept-Ranges': 'bytes',
    ...(status === 206 ? { 'Content-Range': range } : {}),
  });
  job.upload = req;
  pipeline(req, job.res, err => {
    job.upload = undefined;
    if (!err && !res.destroyed) response(res, 200, true);
    else if (!res.destroyed) res.destroy();
  });
}

const assets = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['style.css', ['style.css', 'text/css; charset=utf-8']],
  ['manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['icon.png', ['icon.png', 'image/png']],
  ['markdown.html', ['markdown.html', 'text/html; charset=utf-8']],
  ['markdown.js', ['markdown.js', 'text/javascript; charset=utf-8']],
  ['markdown.css', ['markdown.css', 'text/css; charset=utf-8']],
  ['markdown-it.min.js', ['markdown-it.min.js', 'text/javascript; charset=utf-8']],
  ['markdown-it.LICENSE.txt', ['markdown-it.LICENSE.txt', 'text/plain; charset=utf-8']],
].map(([path, [file, type]]) => [path, [readFileSync(new URL(file, import.meta.url)), type]]));

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(base)) return error(res, 404, 'Not found');
    const route = url.pathname.slice(base.length);
    if (route.startsWith('agent/')) {
      const device = devices.get(req.headers['x-portal-device']);
      if (!device || !check(req.headers.authorization || '', device.hash)) return error(res, 401, 'Unauthorized');
      if (route === 'agent/status' && req.method === 'GET') return response(res, 200, { online: online(device) });
      if (route === 'agent/poll' && req.method === 'GET') return poll(res, device);
      if (route === 'agent/index' && req.method === 'POST') {
        return response(res, 200, index(await body(req), device));
      }
      if (route === 'agent/roots' && req.method === 'POST') {
        const ids = await body(req, 65536);
        if (!Array.isArray(ids) || !ids.every(id => uuid.test(id))) return error(res, 400, 'Invalid roots');
        const registered = new Set(ids);
        for (const root of sql.roots.all()) {
          if (root.device === device.id && !registered.has(root.id)) sql.remove.run(root.id, device.id);
        }
        return response(res, 200, { revoked: sql.revoked.all(device.id).filter(item => registered.has(item.root)) });
      }
      if (route.startsWith('agent/relay/') && req.method === 'POST') {
        return relay(req, res, route.slice('agent/relay/'.length), device);
      }
      return error(res, 404, 'Not found');
    }
    if (assets.has(route) && req.method === 'GET') {
      const [content, type] = assets.get(route);
      res.writeHead(200, { 'Content-Type': type });
      return res.end(content);
    }
    if (req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== config.origin)) return error(res, 403, '访问来源无效。');
    if (route === 'api/login' && req.method === 'POST') {
      if (!req.headers['content-type']?.startsWith('application/json')) return error(res, 415, '请求类型无效。');
      const { password } = await body(req, 1024);
      if (Date.now() > resetFailures) {
        resetFailures = Date.now() + 60000;
        failures = 0;
      }
      if (failures >= 15) return error(res, 429, '尝试次数过多，请稍后重试。');
      if (typeof password !== 'string' || !check(password, config.passwordHash)) {
        await delay(300);
        failures++;
        return error(res, 401, '口令不正确，请检查后重试。');
      }
      const now = Date.now();
      for (const [id, expiry] of sessions) if (expiry <= now) sessions.delete(id);
      if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(32).toString('hex');
      const maxAge = 30 * 24 * 60 * 60;
      sessions.set(token, now + maxAge * 1000);
      res.setHeader('Set-Cookie', setCookie(token, maxAge));
      return response(res, 200, true);
    }
    const token = /(?:^|;\s*)__Secure-fileportal=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    if ((sessions.get(token) ?? 0) <= Date.now()) return error(res, 401, '请先登录。');
    if (route === 'api/logout' && req.method === 'POST') {
      sessions.delete(token);
      res.setHeader('Set-Cookie', setCookie('', 0));
      return response(res, 200, true);
    }
    if (route === 'api/unshare' && req.method === 'POST') {
      const root = url.searchParams.get('root') ?? '';
      if (!uuid.test(root)) return error(res, 400, '目录参数无效。');
      unshare(root);
      return response(res, 200, true);
    }
    if (route === 'api/browse' && req.method === 'GET') {
      const root = url.searchParams.get('root');
      const path = url.searchParams.get('path') ?? '';
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const order = children.get(url.searchParams.get('sort') ?? 'name-asc');
      const query = (url.searchParams.get('q') ?? '').trim();
      if (!root) {
        const locations = [...devices.values()].map(item => ({ id: item.id, name: item.name, online: online(item) }));
        const roots = sql.roots.all().map(record => ({
          ...record, deviceName: devices.get(record.device)?.name ?? '电脑', online: online(devices.get(record.device)),
        }));
        return response(res, 200, { online: locations.some(item => item.online), device: config.deviceName, devices: locations, roots });
      }
      const record = sql.owner.get(root);
      if (!validPath(path) || !Number.isSafeInteger(offset) || offset < 0 || !order || query.length > 255) return error(res, 400, '目录参数无效。');
      if (!record || (path && !sql.entry.get(root, path)?.folder)) return error(res, 404, '目录已移动或移除。');
      const page = order.all(root, path, query, query, offset);
      const device = devices.get(record.device);
      return response(res, 200, { online: online(device), device: device?.name ?? '电脑', root: record, entries: page.slice(0, 200), more: page.length > 200 });
    }
    if (route === 'api/file' && req.method === 'GET') {
      const root = url.searchParams.get('root') ?? '';
      const path = url.searchParams.get('path');
      if (!validPath(path) || !path) return error(res, 400, '文件参数无效。');
      const preview = url.searchParams.get('preview') === '1';
      if (preview && /\.(md|markdown)$/i.test(path) && url.searchParams.get('source') !== '1') {
        const entry = sql.entry.get(root, path);
        if (!entry || entry.folder) return error(res, 404, '找不到文件，请刷新目录。');
        res.writeHead(302, { Location: base + 'markdown.html?' + new URLSearchParams({ root, path }) });
        return res.end();
      }
      return requestFile(req, res, root, path, preview);
    }
    error(res, 404, '页面不存在。');
  } catch (err) {
    console.error(err.message);
    if (!res.headersSent && !res.destroyed) error(res, err.status || 500, '服务暂时无法处理请求。');
  }
});
server.requestTimeout = 0;
server.setTimeout(90000);
server.listen(config.port, '127.0.0.1');
