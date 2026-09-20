import type { DomainView } from './db';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PLATFORM_SUGGESTIONS = [
  '阿里云',
  '腾讯云',
  'Namecheap',
  'Cloudflare',
  'GoDaddy',
  'Namesilo',
  '西部数码',
  '华为云',
  'AWS Route 53',
];

interface DashboardMeta {
  csrf: string;
  lastRunAt: string | null;
  notifyConfigured: boolean;
  schemaReady: boolean;
}

export function renderLogin(csrf: string, error: string | null, passwordMissing: boolean): string {
  return layout(
    '登录',
    `
    <main class="login-wrap">
      <form class="card login-card" method="post" action="/login">
        <h1>域名到期看板</h1>
        <p class="muted">跨注册商统一监控域名到期时间</p>
        ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}
        ${
          passwordMissing
            ? `<div class="alert alert-error">尚未设置 <code>ADMIN_PASSWORD</code> Secret，看板已拒绝所有访问。<br>部署后执行：<code>wrangler secret put ADMIN_PASSWORD</code></div>`
            : `
        <label class="field">
          <span>访问密码</span>
          <input type="password" name="password" autocomplete="current-password" autofocus required>
        </label>
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <button class="btn btn-primary" type="submit">登录</button>`
        }
      </form>
    </main>`
  );
}

export function renderSetupNeeded(): string {
  return layout(
    '需要初始化',
    `<main class="wrap">
      <div class="card">
        <h1>数据库尚未初始化</h1>
        <p class="muted">在项目目录执行以下命令创建表结构，然后刷新本页：</p>
        <pre class="codeblock">npm run db:init:remote</pre>
      </div>
    </main>`
  );
}

export function renderDashboard(views: DomainView[], meta: DashboardMeta): string {
  const stats = summarize(views);

  return layout(
    '域名到期看板',
    `<main class="wrap">
      <header class="topbar">
        <div>
          <h1>域名到期看板</h1>
          <p class="muted">
            ${stats.total} 个域名 · 数据源 RDAP / WHOIS ·
            ${meta.lastRunAt ? `上次全量刷新 ${esc(friendlyTime(meta.lastRunAt))}` : '尚未执行过定时刷新'}
            ${meta.notifyConfigured ? '' : ' · <span class="warn-text">未配置通知 Webhook</span>'}
          </p>
        </div>
        <div class="topbar-actions">
          <button class="btn" id="refresh-all" ${stats.total ? '' : 'disabled'}>刷新全部</button>
          <form method="post" action="/logout" class="inline">
            <input type="hidden" name="csrf" value="${esc(meta.csrf)}">
            <button class="btn btn-quiet" type="submit">退出</button>
          </form>
        </div>
      </header>

      <section class="stats">
        ${statCard('expired', '已过期', stats.expired)}
        ${statCard('urgent', '7 天内', stats.urgent)}
        ${statCard('warn', '30 天内', stats.warn)}
        ${statCard('ok', '正常', stats.ok)}
        ${statCard('unknown', '未知 / 失败', stats.unknown)}
      </section>

      <section class="card add-card">
        <h2>添加域名</h2>
        <form id="add-form" class="add-form" autocomplete="off">
          <label class="field field-grow">
            <span>域名</span>
            <input name="domain" placeholder="example.com" required>
          </label>
          <label class="field">
            <span>注册平台</span>
            <input name="platform" list="platform-list" placeholder="阿里云">
          </label>
          <datalist id="platform-list">
            ${PLATFORM_SUGGESTIONS.map((p) => `<option value="${esc(p)}">`).join('')}
          </datalist>
          <label class="field field-grow">
            <span>备注</span>
            <input name="note" placeholder="可选">
          </label>
          <label class="checkbox">
            <input type="checkbox" name="autoRenew"> 已开自动续费
          </label>
          <button class="btn btn-primary" type="submit">添加并查询</button>
        </form>
        <details class="bulk">
          <summary>批量导入</summary>
          <form id="bulk-form">
            <textarea name="domains" rows="5" placeholder="每行一个域名，可用空格或逗号附上平台标注：&#10;example.com 阿里云&#10;foo.dev Namecheap"></textarea>
            <button class="btn" type="submit">导入</button>
          </form>
        </details>
        <div id="add-status" class="add-status" role="status"></div>
      </section>

      <section class="card">
        ${views.length ? renderTable(views, meta.csrf) : renderEmpty()}
      </section>
    </main>
    <script>${DASHBOARD_JS}</script>`
  );
}

function renderEmpty(): string {
  return `<div class="empty">
      <p>还没有域名。在上方添加第一个，或从注册商控制台把域名列表粘进「批量导入」。</p>
      <p class="muted">到期时间取自注册局公开数据（RDAP / WHOIS），不需要任何平台的 API 密钥。</p>
    </div>`;
}

function renderTable(views: DomainView[], csrf: string): string {
  return `<table class="domains">
      <thead>
        <tr>
          <th>域名</th>
          <th>到期日</th>
          <th class="num">剩余</th>
          <th>注册商</th>
          <th>平台</th>
          <th class="center">自动续费</th>
          <th>上次检查</th>
          <th class="actions-col"></th>
        </tr>
      </thead>
      <tbody>
        ${views.map((v) => renderRow(v, csrf)).join('')}
      </tbody>
    </table>`;
}

function renderRow(v: DomainView, csrf: string): string {
  const date = v.expires_at ? v.expires_at.slice(0, 10) : '—';
  const badge =
    v.daysLeft === null
      ? `<span class="badge badge-unknown">${v.checked_at ? '未知' : '未查询'}</span>`
      : `<span class="badge badge-${v.level}">${
          v.daysLeft < 0 ? `已过期 ${Math.abs(v.daysLeft)} 天` : v.daysLeft === 0 ? '今天到期' : `${v.daysLeft} 天`
        }</span>`;

  return `<tr data-id="${v.id}" data-domain="${esc(v.domain)}" class="row-${v.level}">
      <td class="cell-domain">
        <span class="domain-name">${esc(v.domain)}</span>
        ${v.note ? `<span class="note">${esc(v.note)}</span>` : ''}
        ${v.last_error ? `<span class="err" title="${esc(v.last_error)}">${esc(truncate(v.last_error, 60))}</span>` : ''}
      </td>
      <td class="mono">${esc(date)}</td>
      <td class="num">${badge}</td>
      <td class="small">${esc(v.registrar ?? '—')}</td>
      <td class="small">${esc(v.platform || '—')}</td>
      <td class="center">
        <button class="toggle ${v.auto_renew ? 'on' : ''}" data-action="toggle-renew" data-id="${v.id}"
                title="点击切换自动续费标记（仅记录，不会真的去注册商开启）" aria-pressed="${v.auto_renew ? 'true' : 'false'}">
          ${v.auto_renew ? '开' : '关'}
        </button>
      </td>
      <td class="small muted">${v.checked_at ? esc(friendlyTime(v.checked_at)) : '—'}${
        v.source ? ` · ${esc(v.source)}` : ''
      }</td>
      <td class="actions-col">
        <button class="icon-btn" data-action="refresh" data-id="${v.id}" title="立即查询这个域名" aria-label="刷新 ${esc(v.domain)}">
          ${ICON_REFRESH}
        </button>
        <form method="post" action="/api/domains/${v.id}/delete" class="inline" data-confirm="${esc(v.domain)}">
          <input type="hidden" name="csrf" value="${esc(csrf)}">
          <button class="icon-btn icon-danger" type="submit" title="移除 ${esc(v.domain)}" aria-label="移除 ${esc(v.domain)}">
            ${ICON_TRASH}
          </button>
        </form>
      </td>
    </tr>`;
}

function summarize(views: DomainView[]) {
  const s = { total: views.length, expired: 0, urgent: 0, warn: 0, ok: 0, unknown: 0 };
  for (const v of views) s[v.level]++;
  return s;
}

function statCard(level: string, label: string, count: number): string {
  return `<div class="stat stat-${level}">
      <span class="stat-num">${count}</span>
      <span class="stat-label">${esc(label)}</span>
    </div>`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function friendlyTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} 天前`;
  return iso.slice(0, 10);
}

const ICON_REFRESH =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

export function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

const CSS = `
:root {
  --bg: #f6f7f9; --card: #fff; --border: #e3e6ea; --text: #1b1f24; --muted: #6b7480;
  --expired: #c0392b; --urgent: #d35400; --warn: #b7791f; --ok: #2f7a4d; --unknown: #7a828c;
  --accent: #2563eb; --hover: #f0f2f5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171a; --card: #1c2024; --border: #2b3138; --text: #e6e9ec; --muted: #98a2ad;
    --expired: #ff7b6b; --urgent: #ffa64d; --warn: #ffd166; --ok: #6bd49a; --unknown: #8c959f;
    --accent: #6ea8fe; --hover: #23282e;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
.wrap { max-width: 1180px; margin: 0 auto; padding: 24px 20px 64px; }
.muted { color: var(--muted); font-size: 12.5px; }
.small { font-size: 12.5px; }
.mono { font-variant-numeric: tabular-nums; }
h1 { font-size: 19px; margin: 0 0 2px; font-weight: 650; }
h2 { font-size: 14px; margin: 0 0 12px; font-weight: 620; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.topbar-actions { display: flex; gap: 8px; align-items: center; }
.warn-text { color: var(--warn); }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin-bottom: 16px; }
.stat { background: var(--card); border: 1px solid var(--border); border-left-width: 3px; border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; }
.stat-num { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.2; }
.stat-label { font-size: 12px; color: var(--muted); }
.stat-expired { border-left-color: var(--expired); } .stat-expired .stat-num { color: var(--expired); }
.stat-urgent { border-left-color: var(--urgent); } .stat-urgent .stat-num { color: var(--urgent); }
.stat-warn { border-left-color: var(--warn); } .stat-warn .stat-num { color: var(--warn); }
.stat-ok { border-left-color: var(--ok); } .stat-ok .stat-num { color: var(--ok); }
.stat-unknown { border-left-color: var(--unknown); } .stat-unknown .stat-num { color: var(--unknown); }

.add-form { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 130px; }
.field > span { font-size: 12px; color: var(--muted); }
.field-grow { flex: 1 1 180px; }
input[type=text], input[type=password], input:not([type]), textarea {
  font: inherit; padding: 7px 9px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg); color: var(--text); width: 100%;
}
input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
textarea { resize: vertical; font-family: inherit; }
.checkbox { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); padding-bottom: 8px; white-space: nowrap; }
.bulk { margin-top: 12px; }
.bulk summary { cursor: pointer; font-size: 12.5px; color: var(--muted); }
.bulk form { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.bulk textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.add-status { margin-top: 10px; font-size: 13px; }
.add-status:empty { margin-top: 0; }
.add-status.err { color: var(--expired); }
.add-status.ok { color: var(--ok); }

.btn {
  font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border); background: var(--card); color: var(--text); white-space: nowrap;
}
.btn:hover:not(:disabled) { background: var(--hover); }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.btn-quiet { border-color: transparent; background: transparent; color: var(--muted); font-size: 12.5px; }
.btn-quiet:hover { background: var(--hover); color: var(--text); }

table.domains { width: 100%; border-collapse: collapse; }
table.domains th {
  text-align: left; font-size: 11.5px; font-weight: 600; color: var(--muted); text-transform: uppercase;
  letter-spacing: .03em; padding: 0 10px 8px; border-bottom: 1px solid var(--border);
}
table.domains td { padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
table.domains tbody tr:last-child td { border-bottom: none; }
table.domains tbody tr:hover { background: var(--hover); }
.num { text-align: right; } .center { text-align: center; }
th.num { text-align: right; }
.cell-domain { display: flex; flex-direction: column; gap: 1px; min-width: 180px; }
.domain-name { font-weight: 550; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.note { font-size: 11.5px; color: var(--muted); }
.err { font-size: 11.5px; color: var(--expired); }

.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
.badge-expired { background: color-mix(in srgb, var(--expired) 16%, transparent); color: var(--expired); }
.badge-urgent { background: color-mix(in srgb, var(--urgent) 16%, transparent); color: var(--urgent); }
.badge-warn { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.badge-ok { background: color-mix(in srgb, var(--ok) 14%, transparent); color: var(--ok); }
.badge-unknown { background: color-mix(in srgb, var(--unknown) 16%, transparent); color: var(--unknown); }

.actions-col { width: 1%; white-space: nowrap; text-align: right; }
.actions-col form { display: inline; }
.icon-btn {
  background: none; border: none; cursor: pointer; padding: 4px; border-radius: 5px;
  color: var(--muted); display: inline-flex; align-items: center; vertical-align: middle;
}
.icon-btn:hover { background: var(--hover); color: var(--text); }
.icon-btn:disabled { opacity: .4; cursor: wait; }
/* 删除是破坏性操作，刻意做成低调的灰色图标：不描红边、不用实心按钮 */
.icon-danger:hover { color: var(--expired); }
.icon-btn.spinning svg { animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.toggle {
  font: inherit; font-size: 11.5px; padding: 2px 9px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--border); background: var(--bg); color: var(--muted);
}
.toggle.on { background: color-mix(in srgb, var(--ok) 15%, transparent); border-color: color-mix(in srgb, var(--ok) 40%, transparent); color: var(--ok); font-weight: 600; }

.empty { text-align: center; padding: 32px 16px; color: var(--muted); }
.alert { padding: 9px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 12px; }
.alert-error { background: color-mix(in srgb, var(--expired) 12%, transparent); color: var(--expired); }
.alert code { background: rgba(127,127,127,.18); padding: 1px 4px; border-radius: 3px; }
.codeblock { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; overflow-x: auto; font-size: 12.5px; }

.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
.login-card { width: 100%; max-width: 360px; padding: 28px; }
.login-card h1 { font-size: 18px; }
.login-card .field { margin: 18px 0 16px; }
.login-card .btn { width: 100%; }
.inline { display: inline; }

@media (max-width: 760px) {
  .wrap { padding: 16px 12px 48px; }
  table.domains thead { display: none; }
  table.domains, table.domains tbody, table.domains tr, table.domains td { display: block; width: 100%; }
  table.domains tr { border-bottom: 1px solid var(--border); padding: 8px 0; }
  table.domains td { border: none; padding: 3px 0; display: flex; justify-content: space-between; gap: 12px; }
  table.domains td::before { content: attr(data-label); color: var(--muted); font-size: 11.5px; flex-shrink: 0; }
  .cell-domain { flex-direction: row; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  table.domains td.actions-col { justify-content: flex-end; gap: 8px; }
}
`;

/** 移动端把表格转成卡片后，用 data-label 补回列名 */
const MOBILE_LABELS = `
(function () {
  var labels = ['域名', '到期日', '剩余', '注册商', '平台', '自动续费', '上次检查', ''];
  document.querySelectorAll('table.domains tbody tr').forEach(function (tr) {
    tr.querySelectorAll('td').forEach(function (td, i) {
      if (labels[i]) td.setAttribute('data-label', labels[i]);
    });
  });
})();
`;

const DASHBOARD_JS = `
${MOBILE_LABELS}
(function () {
  var status = document.getElementById('add-status');

  function setStatus(msg, kind) {
    if (!status) return;
    status.textContent = msg || '';
    status.className = 'add-status' + (kind ? ' ' + kind : '');
  }

  function api(path, opts) {
    return fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json', 'x-requested-with': 'domain-manager' }
    }, opts || {})).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body.error || ('HTTP ' + r.status));
        return body;
      });
    });
  }

  var addForm = document.getElementById('add-form');
  if (addForm) addForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var fd = new FormData(addForm);
    setStatus('查询中…');
    addForm.querySelector('button[type=submit]').disabled = true;
    api('/api/domains', {
      method: 'POST',
      body: JSON.stringify({
        domain: fd.get('domain'), platform: fd.get('platform'),
        note: fd.get('note'), autoRenew: !!fd.get('autoRenew')
      })
    }).then(function (res) {
      if (res.warning) setStatus(res.warning, 'err');
      else location.reload();
    }).catch(function (err) {
      setStatus(err.message, 'err');
    }).finally(function () {
      addForm.querySelector('button[type=submit]').disabled = false;
    });
  });

  var bulkForm = document.getElementById('bulk-form');
  if (bulkForm) bulkForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var raw = bulkForm.querySelector('textarea').value;
    var items = raw.split(/[\\r\\n]+/).map(function (l) { return l.trim(); }).filter(Boolean).map(function (line) {
      var parts = line.split(/[\\s,]+/);
      return { domain: parts[0], platform: parts.slice(1).join(' ') };
    });
    if (!items.length) { setStatus('没有可导入的域名', 'err'); return; }
    setStatus('导入 ' + items.length + ' 个域名…');
    api('/api/domains/bulk', { method: 'POST', body: JSON.stringify({ items: items }) })
      .then(function () { location.reload(); })
      .catch(function (err) { setStatus(err.message, 'err'); });
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');

    if (btn.dataset.action === 'refresh') {
      e.preventDefault();
      btn.disabled = true; btn.classList.add('spinning');
      api('/api/domains/' + id + '/refresh', { method: 'POST' })
        .then(function () { location.reload(); })
        .catch(function (err) { alert(err.message); btn.disabled = false; btn.classList.remove('spinning'); });
      return;
    }

    if (btn.dataset.action === 'toggle-renew') {
      e.preventDefault();
      var next = !btn.classList.contains('on');
      btn.disabled = true;
      api('/api/domains/' + id, { method: 'PATCH', body: JSON.stringify({ autoRenew: next }) })
        .then(function () {
          btn.classList.toggle('on', next);
          btn.textContent = next ? '开' : '关';
          btn.setAttribute('aria-pressed', String(next));
        })
        .catch(function (err) { alert(err.message); })
        .finally(function () { btn.disabled = false; });
    }
  });

  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!confirm('从看板移除 ' + form.getAttribute('data-confirm') + ' ？\\n（只是不再监控，不会影响域名本身）')) e.preventDefault();
    });
  });

  var refreshAll = document.getElementById('refresh-all');
  if (refreshAll) refreshAll.addEventListener('click', function () {
    refreshAll.disabled = true;
    refreshAll.textContent = '刷新中…';
    api('/api/refresh', { method: 'POST' })
      .then(function (res) {
        refreshAll.textContent = '完成：' + res.ok + ' 成功';
        if (res.failed) refreshAll.textContent += ' / ' + res.failed + ' 失败';
        setTimeout(function () { location.reload(); }, 700);
      })
      .catch(function (err) { alert(err.message); refreshAll.disabled = false; refreshAll.textContent = '刷新全部'; });
  });
})();
`;
