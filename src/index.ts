import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from './env';
import {
  addDomain,
  applyDateFilter,
  d1Cache,
  deleteDomain,
  deleteSetting,
  getDomainByLabel,
  isSchemaReady,
  listDomains,
  parseDateFilter,
  sortViews,
  toView,
  updateDomain,
  writeSetting,
} from './db';
import { normalizeDomain } from './lookup/domain';
import { refreshAll, refreshDomain } from './scheduler';
import {
  clearCookie,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  hashPassword,
  issueSession,
  readSessionCookie,
  timingSafeEqualStr,
  verifySession,
} from './auth';
import {
  loadSettings,
  normalizeCurrency,
  normalizeWebhookType,
  passwordMode,
  signingMaterial,
  verifyPassword,
  type AppSettings,
} from './settings';
import { esc, renderDashboard, renderLogin, renderSettings, renderSetupNeeded } from './ui';
import { parseCostInput } from './cost';

const app = new Hono<{ Bindings: Env; Variables: { settings: AppSettings } }>();

const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_SECONDS = 900;

app.get('/healthz', async (c) => {
  const ready = await isSchemaReady(c.env.DB).catch(() => false);
  return c.json({ ok: true, schemaReady: ready, time: new Date().toISOString() });
});

app.get('/login', async (c) => {
  const settings = await loadSettings(c.env);
  if (passwordMode(settings) === 'none') return c.html(renderLogin('', null, true), 200);

  const notice = c.req.query('reset') ? '密码已更新，请用新密码登录' : null;
  return c.html(renderLogin(await csrfToken(signingMaterial(settings)), null, false, notice));
});

app.post('/login', async (c) => {
  const settings = await loadSettings(c.env);
  const material = signingMaterial(settings);
  if (!material) return c.html(renderLogin('', null, true), 503);

  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const cache = d1Cache(c.env.DB);
  const token = await csrfToken(material);
  if (await isLoginBlocked(cache, ip)) {
    return c.html(renderLogin(token, '尝试次数过多，请 15 分钟后再试', false), 429);
  }

  const form = await c.req.parseBody();
  const submitted = String(form.password ?? '');

  // 先比 CSRF 再跑 PBKDF2，避免被跨站请求白嫖一轮哈希计算
  if (!timingSafeEqualStr(String(form.csrf ?? ''), token) || !(await verifyPassword(settings, submitted))) {
    await recordLoginFailure(cache, ip);
    return c.html(renderLogin(token, '密码错误', false), 401);
  }

  await clearLoginFailures(cache, ip);
  const isSecure = new URL(c.req.url).protocol === 'https:';
  c.header('Set-Cookie', await issueSession(material, isSecure));
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
  const settings = await loadSettings(c.env);
  c.set('settings', settings);
  if (c.env.DISABLE_AUTH === '1') return next();

  const material = signingMaterial(settings);
  if (!material) {
    return c.text('未配置登录密码，看板已禁用。执行 wrangler secret put ADMIN_PASSWORD', 503);
  }

  const ok = await verifySession(readSessionCookie(c.req.header('cookie')), material);
  if (!ok) {
    if (c.req.path.startsWith('/api/')) return c.json({ error: '未登录或会话已过期' }, 401);
    return c.redirect('/login', 302);
  }
  return next();
});

app.get('/', async (c) => {
  if (!(await isSchemaReady(c.env.DB))) return c.html(renderSetupNeeded(), 503);

  const settings = c.get('settings');
  const rows = await listDomains(c.env.DB);
  const filter = parseDateFilter(c.req.query());
  const all = sortViews(rows.map((r) => toView(r)));
  const views = filter ? applyDateFilter(all, filter) : all;
  const lastRun = await c.env.DB.prepare('SELECT MAX(checked_at) AS t FROM checks').first<{ t: string | null }>();

  return c.html(
    renderDashboard(views, {
      csrf: await csrfToken(signingMaterial(settings)),
      lastRunAt: lastRun?.t ?? null,
      notifyConfigured: Boolean(settings.webhookUrl),
      currency: settings.currency,
      schemaReady: true,
      total: all.length,
      filter: {
        field: filter?.field ?? 'expiry',
        from: filter?.from ?? '',
        to: filter?.to ?? '',
        active: filter !== null,
      },
    })
  );
});

app.get('/settings', async (c) => {
  const settings = c.get('settings');
  return c.html(
    renderSettings({
      settings,
      mode: passwordMode(settings),
      csrf: await csrfToken(signingMaterial(settings)),
      error: null,
      saved: c.req.query('saved') === '1',
    })
  );
});

/** 表单提交（非 fetch），所以用 csrf 隐藏字段而不是自定义请求头 */
app.post('/api/settings', async (c) => {
  const settings = c.get('settings');
  const material = signingMaterial(settings);
  const token = await csrfToken(material);
  const form = await c.req.parseBody();
  const str = (key: string) => String(form[key] ?? '').trim();

  const fail = (error: string, status: ContentfulStatusCode = 400) =>
    c.html(renderSettings({ settings, mode: passwordMode(settings), csrf: token, error, saved: false }), status);

  if (!timingSafeEqualStr(str('csrf'), token)) return fail('CSRF 校验失败', 403);

  const db = c.env.DB;
  // 只写提交上来的字段：表单里没出现的配置保持原样，避免局部提交把其他项重置成默认值
  if (form.currency !== undefined) await writeSetting(db, 'currency', normalizeCurrency(str('currency')));
  if (form.webhook_type !== undefined) {
    await writeSetting(db, 'webhook_type', normalizeWebhookType(str('webhook_type')));
  }

  if (form.notify_days !== undefined) {
    const daysRaw = str('notify_days');
    if (!daysRaw) {
      await deleteSetting(db, 'notify_days');
    } else {
      const parts = daysRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!parts.length || !parts.every((p) => /^\d{1,4}$/.test(p))) {
        return fail('提醒天数格式不正确，示例：30,7,1,0');
      }
      const normalized = Array.from(new Set(parts.map(Number)))
        .sort((a, b) => b - a)
        .join(',');
      await writeSetting(db, 'notify_days', normalized);
    }
  }

  // Webhook 地址在页面上是打码显示的，输入框留空表示「不改」，清除要勾下面的复选框
  if (form.webhook_clear) {
    await deleteSetting(db, 'webhook_url');
  } else {
    const url = str('webhook_url');
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return fail('Webhook 地址不是合法 URL');
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return fail('Webhook 地址必须以 http(s):// 开头');
      }
      await writeSetting(db, 'webhook_url', url.slice(0, 500));
    }
  }

  const next = str('new_password');
  if (next) {
    if (next.length < 8) return fail('新密码至少 8 位');
    if (next !== str('confirm_password')) return fail('两次输入的新密码不一致');
    if (material && !(await verifyPassword(settings, str('current_password')))) {
      return fail('当前密码不正确');
    }
    await writeSetting(db, 'admin_password', await hashPassword(next));
    // 签名密钥由密码派生，改完密码旧会话全部失效
    c.header('Set-Cookie', clearCookie());
    return c.redirect('/login?reset=1', 302);
  }

  return c.redirect('/settings?saved=1', 302);
});

app.get('/api/domains', async (c) => {
  const rows = await listDomains(c.env.DB);
  return c.json({ domains: sortViews(rows.map((r) => toView(r))) });
});

app.post('/api/domains', async (c) => {
  if (!csrfOk(c)) return c.json({ error: 'CSRF 校验失败' }, 403);

  const body = await c.req.json<{
    domain?: string;
    platform?: string;
    note?: string;
    autoRenew?: boolean;
    cost?: unknown;
  }>();
  const normalized = normalizeDomain(String(body.domain ?? ''));
  if (!normalized) return c.json({ error: '域名格式不正确' }, 400);

  const cost = parseCostInput(body.cost);
  if (cost.error) return c.json({ error: cost.error }, 400);

  const added = await addDomain(c.env.DB, {
    domain: normalized,
    platform: String(body.platform ?? '').slice(0, 60),
    note: String(body.note ?? '').slice(0, 200),
    autoRenew: Boolean(body.autoRenew),
    cost: cost.value,
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

  const body = await c.req.json<{ items?: { domain?: string; platform?: string; cost?: unknown }[] }>();
  const items = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
  let added = 0;
  const skipped: string[] = [];

  for (const item of items) {
    const normalized = normalizeDomain(String(item?.domain ?? ''));
    if (!normalized) {
      skipped.push(String(item?.domain ?? '(空)'));
      continue;
    }
    const cost = parseCostInput(item?.cost);
    const res = await addDomain(c.env.DB, {
      domain: normalized,
      platform: String(item?.platform ?? '').slice(0, 60),
      cost: cost.value,
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
    cost?: unknown;
  }>();

  let cost: number | null | undefined;
  if (body.cost !== undefined) {
    const parsed = parseCostInput(body.cost);
    if (parsed.error) return c.json({ error: parsed.error }, 400);
    cost = parsed.value;
  }

  const ok = await updateDomain(c.env.DB, id, {
    ...(body.platform !== undefined ? { platform: String(body.platform).slice(0, 60) } : {}),
    ...(body.note !== undefined ? { note: String(body.note).slice(0, 200) } : {}),
    ...(body.autoRenew !== undefined ? { autoRenew: Boolean(body.autoRenew) } : {}),
    ...(body.notify !== undefined ? { notify: Boolean(body.notify) } : {}),
    ...(cost !== undefined ? { cost } : {}),
  });
  return ok ? c.json({ ok: true, cost: cost ?? null }) : c.json({ error: '未更新任何字段' }, 400);
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
  if (!timingSafeEqualStr(String(form.csrf ?? ''), await csrfToken(signingMaterial(c.get('settings'))))) {
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
async function csrfToken(material: string | null): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(material ?? 'unset'),
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
