import { Hono } from 'hono';
import type { Env } from './env';
import {
  addDomain,
  d1Cache,
  deleteDomain,
  getDomainByLabel,
  isSchemaReady,
  listDomains,
  sortViews,
  toView,
  updateDomain,
} from './db';
import { normalizeDomain } from './lookup/domain';
import { refreshAll, refreshDomain } from './scheduler';
import {
  clearCookie,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  issueSession,
  readSessionCookie,
  timingSafeEqualStr,
  verifySession,
} from './auth';
import { esc, renderDashboard, renderLogin, renderSetupNeeded } from './ui';

const app = new Hono<{ Bindings: Env }>();

const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_SECONDS = 900;

app.get('/healthz', async (c) => {
  const ready = await isSchemaReady(c.env.DB).catch(() => false);
  return c.json({ ok: true, schemaReady: ready, time: new Date().toISOString() });
});

app.get('/login', async (c) => {
  if (!c.env.ADMIN_PASSWORD) return c.html(renderLogin('', null, true), 200);
  return c.html(renderLogin(await csrfToken(c.env), null, false));
});

app.post('/login', async (c) => {
  const password = c.env.ADMIN_PASSWORD;
  if (!password) return c.html(renderLogin('', null, true), 503);

  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const cache = d1Cache(c.env.DB);
  const token = await csrfToken(c.env);
  if (await isLoginBlocked(cache, ip)) {
    return c.html(renderLogin(token, '尝试次数过多，请 15 分钟后再试', false), 429);
  }

  const form = await c.req.parseBody();
  const submitted = String(form.password ?? '');

  if (!timingSafeEqualStr(String(form.csrf ?? ''), token) || !timingSafeEqualStr(submitted, password)) {
    await recordLoginFailure(cache, ip);
    return c.html(renderLogin(token, '密码错误', false), 401);
  }

  await clearLoginFailures(cache, ip);
  const isSecure = new URL(c.req.url).protocol === 'https:';
  c.header('Set-Cookie', await issueSession(password, isSecure));
  return c.redirect('/', 302);
});

app.post('/logout', (c) => {
  c.header('Set-Cookie', clearCookie());
  return c.redirect('/login', 302);
});

/**
 * 以下路由都需要已登录。
 * Hono 的中间件只对注册在其之后的路由生效，/healthz、/login、/logout 已在上面注册，天然跳过。
 */
app.use('*', async (c, next) => {
  if (c.env.DISABLE_AUTH === '1') return next();

  const password = c.env.ADMIN_PASSWORD;
  if (!password) return c.text('未配置 ADMIN_PASSWORD，看板已禁用。执行 wrangler secret put ADMIN_PASSWORD', 503);

  const ok = await verifySession(readSessionCookie(c.req.header('cookie')), password);
  if (!ok) {
    if (c.req.path.startsWith('/api/')) return c.json({ error: '未登录或会话已过期' }, 401);
    return c.redirect('/login', 302);
  }
  return next();
});

app.get('/', async (c) => {
  if (!(await isSchemaReady(c.env.DB))) return c.html(renderSetupNeeded(), 503);

  const rows = await listDomains(c.env.DB);
  const views = sortViews(rows.map((r) => toView(r)));
  const lastRun = await c.env.DB.prepare('SELECT MAX(checked_at) AS t FROM checks').first<{ t: string | null }>();

  return c.html(
    renderDashboard(views, {
      csrf: await csrfToken(c.env),
      lastRunAt: lastRun?.t ?? null,
      notifyConfigured: Boolean(c.env.WEBHOOK_URL?.trim()),
      schemaReady: true,
    })
  );
});

app.get('/api/domains', async (c) => {
  const rows = await listDomains(c.env.DB);
  return c.json({ domains: sortViews(rows.map((r) => toView(r))) });
});

app.post('/api/domains', async (c) => {
  if (!csrfOk(c)) return c.json({ error: 'CSRF 校验失败' }, 403);

  const body = await c.req.json<{ domain?: string; platform?: string; note?: string; autoRenew?: boolean }>();
  const normalized = normalizeDomain(String(body.domain ?? ''));
  if (!normalized) return c.json({ error: '域名格式不正确' }, 400);

  const added = await addDomain(c.env.DB, {
    domain: normalized,
    platform: String(body.platform ?? '').slice(0, 60),
    note: String(body.note ?? '').slice(0, 200),
    autoRenew: Boolean(body.autoRenew),
  });
  if (!added.ok) return c.json({ error: added.error }, 409);

  const result = await refreshDomain(c.env, added.row);
  return c.json({
    domain: added.row.domain,
    expiresAt: result.expiresAt,
    registrar: result.registrar,
    source: result.source,
    warning:
      result.status === 'ok'
        ? null
        : result.status === 'notfound'
          ? '已添加，但注册局中查不到该域名（可能未注册或已删除）'
          : `已添加，但查询失败：${result.error ?? '未知错误'}`,
  });
});

app.post('/api/domains/bulk', async (c) => {
  if (!csrfOk(c)) return c.json({ error: 'CSRF 校验失败' }, 403);

  const body = await c.req.json<{ items?: { domain?: string; platform?: string }[] }>();
  const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
  let added = 0;
  const skipped: string[] = [];

  for (const item of items) {
    const normalized = normalizeDomain(String(item?.domain ?? ''));
    if (!normalized) {
      skipped.push(String(item?.domain ?? '(空)'));
      continue;
    }
    const res = await addDomain(c.env.DB, {
      domain: normalized,
      platform: String(item?.platform ?? '').slice(0, 60),
    });
    if (res.ok) added++;
    else skipped.push(normalized);
  }
  return c.json({ added, skipped });
});

app.patch('/api/domains/:id', async (c) => {
  if (!csrfOk(c)) return c.json({ error: 'CSRF 校验失败' }, 403);

  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'id 无效' }, 400);

  const body = await c.req.json<{
    platform?: string;
    note?: string;
    autoRenew?: boolean;
    notify?: boolean;
  }>();
  const ok = await updateDomain(c.env.DB, id, {
    ...(body.platform !== undefined ? { platform: String(body.platform).slice(0, 60) } : {}),
    ...(body.note !== undefined ? { note: String(body.note).slice(0, 200) } : {}),
    ...(body.autoRenew !== undefined ? { autoRenew: Boolean(body.autoRenew) } : {}),
    ...(body.notify !== undefined ? { notify: Boolean(body.notify) } : {}),
  });
  return ok ? c.json({ ok: true }) : c.json({ error: '未更新任何字段' }, 400);
});

app.post('/api/domains/:id/refresh', async (c) => {
  if (!csrfOk(c)) return c.json({ error: 'CSRF 校验失败' }, 403);

  const id = Number(c.req.param('id'));
  const rows = await listDomains(c.env.DB);
  const row = rows.find((r) => r.id === id);
  if (!row) return c.json({ error: '域名不存在' }, 404);

  const result = await refreshDomain(c.env, row);
  return c.json(result);
});

/** 表单提交（非 fetch），所以用 csrf 隐藏字段而不是自定义请求头 */
app.post('/api/domains/:id/delete', async (c) => {
  const form = await c.req.parseBody();
  if (!timingSafeEqualStr(String(form.csrf ?? ''), await csrfToken(c.env))) {
    return c.json({ error: 'CSRF 校验失败' }, 403);
  }
  const id = Number(c.req.param('id'));
  await deleteDomain(c.env.DB, id);
  return c.redirect('/', 302);
});

app.post('/api/refresh', async (c) => {
  if (!csrfOk(c)) return c.json({ error: 'CSRF 校验失败' }, 403);
  const summary = await refreshAll(c.env);
  return c.json(summary);
});

app.get('/api/checks/:domain', async (c) => {
  const domain = normalizeDomain(c.req.param('domain'));
  if (!domain) return c.json({ error: '域名格式不正确' }, 400);
  const { results } = await c.env.DB.prepare(
    'SELECT checked_at, expires_at, registrar, source, error FROM checks WHERE domain = ?1 ORDER BY checked_at DESC LIMIT 30'
  )
    .bind(domain)
    .all();
  const row = await getDomainByLabel(c.env.DB, domain);
  return c.json({ domain, current: row ? toView(row) : null, history: results ?? [] });
});

app.notFound((c) =>
  c.req.path.startsWith('/api/') ? c.json({ error: 'Not Found' }, 404) : c.redirect('/', 302)
);

app.onError((err, c) => {
  console.error('unhandled error', err);
  const message = err instanceof Error ? err.message : String(err);
  if (c.req.path.startsWith('/api/')) return c.json({ error: message }, 500);
  return c.html(
    `<!DOCTYPE html><meta charset="utf-8"><title>出错了</title><body style="font-family:system-ui;padding:32px">` +
      `<h1>服务器错误</h1><pre>${esc(message)}</pre><p><a href="/">返回看板</a></p></body>`,
    500
  );
});

/** JSON 接口的 CSRF 防线：要求带上自定义头，跨站表单无法设置 */
function csrfOk(c: { req: { header: (name: string) => string | undefined } }): boolean {
  return c.req.header(CSRF_HEADER)?.toLowerCase() === CSRF_HEADER_VALUE;
}

/** 由密码派生的固定 token；配合 SameSite=Lax，跨站请求既拿不到也发不出 */
async function csrfToken(env: Env): Promise<string> {
  const password = env.ADMIN_PASSWORD ?? 'unset';
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(CSRF_TOKEN_MESSAGE));
  return Array.from(new Uint8Array(sig).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const CSRF_TOKEN_MESSAGE = 'domain-manager-csrf-v1';

interface LoginBlock {
  count: number;
  first: number;
}

async function isLoginBlocked(cache: ReturnType<typeof d1Cache>, ip: string): Promise<boolean> {
  const raw = await cache.get(loginKey(ip));
  if (!raw) return false;
  try {
    const block = JSON.parse(raw) as LoginBlock;
    return block.count >= MAX_LOGIN_ATTEMPTS;
  } catch {
    return false;
  }
}

async function recordLoginFailure(cache: ReturnType<typeof d1Cache>, ip: string): Promise<void> {
  const key = loginKey(ip);
  let block: LoginBlock = { count: 0, first: Date.now() };
  const raw = await cache.get(key);
  if (raw) {
    try {
      block = JSON.parse(raw) as LoginBlock;
    } catch {
      /* 记录损坏则重新计数 */
    }
  }
  block.count += 1;
  await cache.set(key, JSON.stringify(block), LOGIN_WINDOW_SECONDS);
}

async function clearLoginFailures(cache: ReturnType<typeof d1Cache>, ip: string): Promise<void> {
  await cache.set(loginKey(ip), JSON.stringify({ count: 0, first: Date.now() }), 60);
}

function loginKey(ip: string): string {
  return `login:fail:${ip}`;
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      refreshAll(env)
        .then((summary) => console.log('scheduled refresh', JSON.stringify(summary)))
        .catch((err) => console.error('scheduled refresh failed', err))
    );
  },
};
