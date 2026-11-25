const $ = id => document.getElementById(id);
const previewable = new Set('jpg jpeg png gif webp avif bmp heic mp4 mov m4v webm mp3 m4a wav ogg pdf txt md markdown csv tsv json yaml yml xml html css js ts py ps1 sh log ini toml r tex bib sql'.split(' '));
const date = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const number = new Intl.NumberFormat('zh-CN');
const elements = { login: $('login'), browser: $('browser'), logout: $('logout'), notice: $('notice'), more: $('more') };
const recentFolders = new Map();
let pages = 1;
let revision = 0;
let lastView = '';
let lastLocation = '';
let active;
let sort = 'name-asc';
let searchTimer;

function route(parameters, endpoint) {
  return endpoint + '?' + new URLSearchParams(parameters);
}

function current() {
  const params = new URLSearchParams(location.hash.slice(1));
  return { root: params.get('root') || '', path: params.get('path') || '' };
}

function folderLink(root, path) {
  return root ? '#' + new URLSearchParams({ root, path }) : '#';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function link(text, href, className) {
  const anchor = el('a', className, text);
  anchor.href = href;
  return anchor;
}

function size(bytes) {
  return number.format(Math.ceil(bytes / 1024)) + ' KB';
}

function showLogin() {
  elements.login.hidden = false;
  elements.browser.hidden = true;
  elements.logout.hidden = true;
  $('entries').replaceChildren();
  recentFolders.clear();
  actionMessage('');
  lastView = '';
  lastLocation = '';
}

function showBrowser() {
  elements.login.hidden = true;
  elements.browser.hidden = false;
  elements.logout.hidden = false;
}

function notice(message) {
  elements.notice.hidden = !message;
  if (elements.notice.textContent !== (message || '')) elements.notice.textContent = message || '';
}

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
}

function actionMessage(message) {
  $('action-message').textContent = message;
  $('action-message').hidden = !message;
}

async function unshare(button, root, name) {
  if (!window.confirm('移除「' + name + '」的查看权限？电脑上的原文件会保留。')) return;
  button.disabled = true;
  actionMessage('');
  try {
    await api(route({ root }, './api/unshare'), { method: 'POST' });
    recentFolders.clear();
    actionMessage('已移除「' + name + '」的查看权限。');
    if (current().root === root) location.hash = '#';
    else await refresh(true);
  } catch (error) {
    actionMessage(error.message);
  } finally {
    button.disabled = false;
  }
}

function render(data, state, entries, more) {
  showBrowser();
  const multiple = !data.root && data.devices?.length > 1;
  const status = multiple ? data.devices.filter(item => item.online).length + ' 台在线' :
    data.online ? '在线' : '离线';
  const deviceLabel = multiple ? data.devices.length + ' 台已接入 · ' : data.device + ' · ';
  if ($('device').textContent !== deviceLabel + status) {
    $('device').replaceChildren(deviceLabel, el('span', data.online ? 'online' : 'offline', status));
  }
  notice(data.online ? '' : '电脑离线。可以浏览上次保存的目录，预览和下载会在电脑上线后恢复。');
  const detailed = Boolean(data.root);
  const view = JSON.stringify([state, data.root, entries, data.roots, more]);
  if (lastView === view) return;
  lastView = view;
  $('folder-tools').hidden = !data.root;
  const rootButton = $('unshare-current');
  rootButton.hidden = !data.root || Boolean(state.path);
  if (data.root) {
    rootButton.dataset.root = data.root.id;
    rootButton.dataset.name = data.root.name;
  }
  $('details-heading').hidden = !detailed;
  $('sort-select').value = state.sort;
  for (const button of $('details-heading').querySelectorAll('button')) {
    const [column, direction] = state.sort.split('-');
    const ordered = column === button.dataset.sort;
    button.dataset.direction = ordered ? direction : '';
    button.setAttribute('aria-pressed', String(ordered));
    button.setAttribute('aria-label', ordered ? button.textContent + (direction === 'asc' ? '，升序' : '，降序') : button.textContent);
  }
  const locationKey = JSON.stringify([state.root, state.path, data.root?.name]);
  if (lastLocation !== locationKey) {
    lastLocation = locationKey;
    const crumbs = $('crumbs');
    crumbs.replaceChildren();
    if (data.root) {
      crumbs.append(link('文件夹', '#'), el('span', '', '›'), link(data.root.name, folderLink(state.root, '')));
      const segments = state.path ? state.path.split('/') : [];
      segments.forEach((name, index) => {
        crumbs.append(el('span', '', '›'), link(name, folderLink(state.root, segments.slice(0, index + 1).join('/'))));
      });
    } else {
      crumbs.append(el('strong', '', '文件夹'));
    }
  }
  const list = $('entries');
  const previousRows = new Map(Array.from(list.children, row => [row.dataset.key, row]));
  const nextRows = [];
  for (const item of data.roots || entries) {
    const key = JSON.stringify([state.root, item.id || item.path, item.name, item.folder,
      item.mtime, item.size, item.type, item.deviceName, item.online]);
    const existing = previousRows.get(key);
    if (existing) {
      nextRows.push(existing);
      previousRows.delete(key);
      continue;
    }
    const row = el('div', detailed ? 'row details-grid' : 'row');
    row.dataset.key = key;
    const isFolder = Boolean(item.id || item.folder);
    const params = { root: state.root, path: item.path };
    const downloadable = route(params, './api/file');
    const dot = item.name.lastIndexOf('.');
    const extension = dot > 0 ? item.name.slice(dot + 1).toLowerCase() : '';
    const canPreview = !isFolder && previewable.has(extension);
    const href = isFolder ? folderLink(item.id || state.root, item.path || '') :
      (canPreview ? route({ ...params, preview: 1 }, './api/file') : downloadable);
    const primary = link('', href, 'item');
    const icon = el('span', isFolder ? 'list-folder' : 'list-file',
      !isFolder && extension && extension.length <= 4 ? extension.toUpperCase() : '');
    icon.setAttribute('aria-hidden', 'true');
    const details = el('span');
    details.append(el('span', 'item-name', item.name));
    const modified = item.mtime == null ? '' : date.format(item.mtime);
    const storage = isFolder ? '' : size(item.size);
    if (item.deviceName) {
      const source = el('span', 'item-info', item.deviceName + ' · ');
      source.append(el('span', item.online ? 'online' : 'offline', item.online ? '在线' : '离线'));
      details.append(source);
    } else if (modified) {
      details.append(el('span', 'item-info', [item.type, modified, storage].filter(Boolean).join(' · ')));
    }
    primary.append(icon, details);
    row.append(primary);
    if (detailed) {
      row.append(el('span', 'detail-date', modified), el('span', 'detail-type', item.type),
        el('span', 'detail-size', storage));
    }
    if (canPreview) {
      primary.target = '_blank';
      primary.rel = 'noopener';
    }
    if (!isFolder) {
      const download = link('下载', downloadable, 'download');
      download.setAttribute('aria-label', '下载 ' + item.name);
      row.append(download);
    } else if (item.id) {
      const remove = el('button', 'quiet unshare', '移除查看');
      remove.type = 'button';
      remove.setAttribute('aria-label', '移除查看 ' + item.name);
      remove.addEventListener('click', () => unshare(remove, item.id, item.name));
      row.append(remove);
    }
    nextRows.push(row);
  }
  if (!nextRows.length) {
    nextRows.push(el('p', 'empty', state.q ? '此文件夹内没有匹配的文件或文件夹。' :
      data.root ? '此文件夹为空。' : '还没有登记文件夹。可以请电脑上的 Codex 把项目加入手机查看服务。'));
  }
  list.classList.toggle('details', detailed);
  for (const stale of previousRows.values()) stale.remove();
  let cursor = list.firstElementChild;
  for (const row of nextRows) {
    if (row === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(row, cursor);
  }
  elements.more.hidden = !more;
}

function browseState() {
  return { ...current(), sort, q: $('folder-search').value.trim() };
}

function cacheKey(state) {
  return JSON.stringify([state, pages]);
}

function showRecent(state) {
  const saved = recentFolders.get(cacheKey(state));
  if (!saved || performance.now() - saved.time > 30000) return false;
  render(saved.data, state, saved.entries, saved.more);
  return true;
}

async function refresh(force = false, useRecent = false) {
  if (active && !force) return;
  if (active) active.abort();
  active = new AbortController();
  const controller = active;
  const sequence = ++revision;
  const state = browseState();
  const key = cacheKey(state);
  if (useRecent) showRecent(state);
  try {
    const options = { signal: controller.signal };
    const data = await api(route(state, './api/browse'), options);
    const entries = data.entries || [];
    let more = data.more;
    for (let page = 1; page < pages && more; page++) {
      const next = await api(route({ ...state, offset: page * 200 }, './api/browse'), options);
      entries.push(...next.entries);
      more = next.more;
    }
    if (sequence === revision) {
      recentFolders.delete(key);
      recentFolders.set(key, { data, entries, more, time: performance.now() });
      if (recentFolders.size > 12) recentFolders.delete(recentFolders.keys().next().value);
      render(data, state, entries, more);
    }
  } catch (error) {
    if (sequence !== revision || error.name === 'AbortError') return;
    if (error.status === 401) showLogin();
    else if (error.status === 404 && state.root) {
      recentFolders.delete(key);
      location.hash = '#';
    }
    else notice(error.status ? error.message : '连接中断，正在重试。');
  } finally {
    if (active === controller) active = undefined;
  }
}

elements.login.addEventListener('submit', async event => {
  event.preventDefault();
  $('login-error').textContent = '';
  try {
    await api('./api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('password').value }),
    });
    $('password').value = '';
    await refresh(true);
  } catch (error) {
    $('login-error').textContent = error.message;
  }
});
elements.logout.addEventListener('click', async () => {
  try {
    await api('./api/logout', { method: 'POST' });
    active?.abort();
    showLogin();
  } catch (error) {
    notice(error.message);
  }
});
$('refresh').addEventListener('click', () => refresh(true));
$('unshare-current').addEventListener('click', event => {
  const button = event.currentTarget;
  unshare(button, button.dataset.root, button.dataset.name);
});
function changeOrder(order) {
  sort = order;
  pages = 1;
  refresh(true, true);
}
$('sort-select').addEventListener('change', event => changeOrder(event.target.value));
for (const heading of $('details-heading').querySelectorAll('[data-sort]')) {
  heading.addEventListener('click', () => {
    const column = heading.dataset.sort;
    changeOrder(column + (sort === column + '-asc' ? '-desc' : '-asc'));
  });
}
$('folder-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { pages = 1; refresh(true); }, 180);
});
elements.more.addEventListener('click', () => { pages++; refresh(true); });
addEventListener('hashchange', () => {
  clearTimeout(searchTimer);
  pages = 1;
  $('folder-search').value = '';
  refresh(true, true);
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
setInterval(() => { if (!document.hidden && elements.login.hidden) refresh(); }, 3000);
refresh();
