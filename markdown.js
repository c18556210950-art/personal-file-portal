const parameters = new URLSearchParams(location.search);
const root = parameters.get('root') ?? '';
const path = parameters.get('path') ?? '';
const filename = path.split('/').pop();
const status = document.getElementById('reader-status');
const content = document.getElementById('document-content');
const download = document.getElementById('source-download');
const folder = document.getElementById('folder-link');
const virtualRoot = 'https://markdown.invalid/root/';
const markdownExtension = /\.(md|markdown)$/i;
const imageExtension = /\.(jpe?g|png|gif|webp|avif|bmp|heic)$/i;
const maxPreviewSize = 4 * 1024 * 1024;

function resourceUrl(route, relativePath, options = {}) {
  return './' + route + '?' + new URLSearchParams({ root, path: relativePath, ...options });
}

function textOfFragment(hash) {
  try { return decodeURIComponent(hash.slice(1)); }
  catch { return hash.slice(1); }
}

function headingSlug(value) {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, '').replace(/\s+/g, '-');
}

function headingHash(hash) {
  return '#section-' + encodeURIComponent(headingSlug(textOfFragment(hash)));
}

function relativeResource(href) {
  try {
    const documentUrl = virtualRoot + path.split('/').map(encodeURIComponent).join('/');
    const url = new URL(href, documentUrl);
    if (url.origin !== new URL(virtualRoot).origin || !url.pathname.startsWith('/root/')) return null;
    const relativePath = url.pathname.slice('/root/'.length).split('/').map(decodeURIComponent).join('/');
    return relativePath ? { path: relativePath, hash: url.hash } : null;
  } catch {
    return null;
  }
}

function renderMarkdown(source) {
  const template = document.createElement('template');
  template.innerHTML = window.markdownit({ html: false }).render(source);
  const headings = new Set();
  for (const heading of template.content.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const base = 'section-' + (headingSlug(heading.textContent) || 'heading');
    let id = base;
    for (let suffix = 1; headings.has(id); suffix++) id = base + '-' + suffix;
    headings.add(id);
    heading.id = id;
  }
  for (const anchor of template.content.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (href.startsWith('#')) {
      anchor.setAttribute('href', headingHash(href));
    } else if (/^https?:\/\//i.test(href)) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    } else if (!/^mailto:/i.test(href)) {
      const attachment = href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href) ?
        null : relativeResource(href);
      if (!attachment) {
        anchor.removeAttribute('href');
      } else if (markdownExtension.test(attachment.path)) {
        anchor.href = resourceUrl('markdown.html', attachment.path) +
          (attachment.hash ? headingHash(attachment.hash) : '');
      } else {
        anchor.href = resourceUrl('api/file', attachment.path, { preview: '1' });
      }
    }
  }
  for (const image of template.content.querySelectorAll('img[src]')) {
    const href = image.getAttribute('src');
    const attachment = href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href) ?
      null : relativeResource(href);
    if (attachment && imageExtension.test(attachment.path)) {
      image.src = resourceUrl('api/file', attachment.path, { preview: '1' });
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => image.replaceWith(image.alt || '图片暂时无法打开'), { once: true });
    } else {
      image.replaceWith(image.alt || '图片');
    }
  }
  for (const table of template.content.querySelectorAll('table')) {
    const container = document.createElement('div');
    container.className = 'table-scroll';
    table.replaceWith(container);
    container.append(table);
  }
  content.replaceChildren(template.content);
  content.hidden = false;
  status.hidden = true;
  if (location.hash) {
    const fragment = textOfFragment(location.hash);
    const target = document.getElementById(fragment.startsWith('section-') ? fragment :
      'section-' + headingSlug(fragment));
    target?.scrollIntoView();
  }
}

async function load() {
  if (!/^[a-f0-9]{32}$/.test(root) || !markdownExtension.test(path)) {
    status.textContent = '找不到 Markdown 文件。';
    return;
  }
  document.title = filename + ' · 个人文件';
  document.getElementById('document-name').textContent = filename;
  folder.href = './#' + new URLSearchParams({ root, path: path.split('/').slice(0, -1).join('/') });
  download.href = resourceUrl('api/file', path);
  download.hidden = false;

  try {
    const response = await fetch(resourceUrl('api/file', path, { preview: '1', source: '1' }));
    if (!response.ok) {
      const data = await response.json();
      if (response.status === 401) {
        folder.href = './';
        folder.textContent = '前往登录';
      }
      status.textContent = data.error || '文件暂时无法打开。';
      return;
    }
    if (Number(response.headers.get('Content-Length')) > maxPreviewSize) {
      await response.body?.cancel();
      status.textContent = '此 Markdown 文件超过 4 MB，请下载原件查看。';
      return;
    }
    renderMarkdown(await response.text());
  } catch {
    status.textContent = '文件暂时无法打开，请刷新或下载原件。';
  }
}

load();
