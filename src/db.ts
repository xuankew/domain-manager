import type { Cache } from './lookup/rdap';
import type { DomainLookup } from './lookup';

export interface DomainRow {
  id: number;
  domain: string;
  platform: string;
  note: string;
  auto_renew: number;
  notify: number;
  cost: number | null;
  created_at: string;
  expires_at: string | null;
  registrar: string | null;
  source: string | null;
  checked_at: string | null;
  last_error: string | null;
}

/** 看板视图模型：在行数据上算好剩余天数与告警级别 */
export interface DomainView extends DomainRow {
  daysLeft: number | null;
  level: 'expired' | 'urgent' | 'warn' | 'ok' | 'unknown';
}

export function d1Cache(db: D1Database): Cache {
  const now = () => Math.floor(Date.now() / 1000);
  return {
    async get(key) {
      const row = await db
        .prepare('SELECT value, expires_at FROM cache WHERE key = ?1')
        .bind(key)
        .first<{ value: string; expires_at: number }>();
      if (!row) return null;
      if (row.expires_at <= now()) {
        await db.prepare('DELETE FROM cache WHERE key = ?1').bind(key).run();
        return null;
      }
      return row.value;
    },
    async set(key, value, ttlSeconds) {
      await db
        .prepare(
          `INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
        )
        .bind(key, value, now() + ttlSeconds)
        .run();
    },
  };
}

export async function listDomains(db: D1Database): Promise<DomainRow[]> {
  const { results } = await db.prepare('SELECT * FROM domains ORDER BY id ASC').all<DomainRow>();
  return results ?? [];
}

export async function getDomainByLabel(db: D1Database, domain: string): Promise<DomainRow | null> {
  return db.prepare('SELECT * FROM domains WHERE domain = ?1').bind(domain).first<DomainRow>();
}

export async function addDomain(
  db: D1Database,
  input: {
    domain: string;
    platform?: string;
    note?: string;
    autoRenew?: boolean;
    notify?: boolean;
    cost?: number | null;
  }
): Promise<{ ok: true; row: DomainRow } | { ok: false; error: string }> {
  const existing = await getDomainByLabel(db, input.domain);
  if (existing) return { ok: false, error: `${input.domain} 已在列表中` };

  await db
    .prepare(
      `INSERT INTO domains (domain, platform, note, auto_renew, notify, cost)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(
      input.domain,
      input.platform ?? '',
      input.note ?? '',
      input.autoRenew ? 1 : 0,
      input.notify === false ? 0 : 1,
      input.cost ?? null
    )
    .run();

  const row = await getDomainByLabel(db, input.domain);
  return row ? { ok: true, row } : { ok: false, error: '写入后未能读回记录' };
}

export async function deleteDomain(db: D1Database, id: number): Promise<boolean> {
  const res = await db.prepare('DELETE FROM domains WHERE id = ?1').bind(id).run();
  await db
    .prepare('DELETE FROM alerts WHERE domain NOT IN (SELECT domain FROM domains)')
    .run()
    .catch(() => {});
  return (res.meta.changes ?? 0) > 0;
}

export async function updateDomain(
  db: D1Database,
  id: number,
  patch: Partial<{ platform: string; note: string; autoRenew: boolean; notify: boolean; cost: number | null }>
): Promise<boolean> {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.platform !== undefined) {
    sets.push('platform = ?' + (values.length + 1));
    values.push(patch.platform);
  }
  if (patch.note !== undefined) {
    sets.push('note = ?' + (values.length + 1));
    values.push(patch.note);
  }
  if (patch.autoRenew !== undefined) {
    sets.push('auto_renew = ?' + (values.length + 1));
    values.push(patch.autoRenew ? 1 : 0);
  }
  if (patch.notify !== undefined) {
    sets.push('notify = ?' + (values.length + 1));
    values.push(patch.notify ? 1 : 0);
  }
  if (patch.cost !== undefined) {
    sets.push('cost = ?' + (values.length + 1));
    values.push(patch.cost);
  }
  if (!sets.length) return false;

  values.push(id);
  const res = await db
    .prepare(`UPDATE domains SET ${sets.join(', ')} WHERE id = ?${values.length}`)
    .bind(...values)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** 写入一次检查结果：更新 domains 上的快照，并追加一条历史。 */
export async function saveLookup(db: D1Database, row: DomainRow, result: DomainLookup): Promise<void> {
  const checkedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expiresAt = result.status === 'ok' ? result.expiresAt : row.expires_at;
  const registrar = result.registrar ?? row.registrar;
  const lastError =
    result.status === 'ok'
      ? null
      : result.status === 'notfound'
        ? '注册局中查不到该域名（可能未注册或已删除）'
        : result.error;

  await db
    .batch([
      db
        .prepare(
          `UPDATE domains SET expires_at = ?1, registrar = ?2, source = ?3, checked_at = ?4, last_error = ?5
           WHERE id = ?6`
        )
        .bind(expiresAt, registrar, result.source, checkedAt, lastError, row.id),
      db
        .prepare(
          `INSERT INTO checks (domain, checked_at, expires_at, registrar, source, error)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
        )
        .bind(row.domain, checkedAt, result.expiresAt, result.registrar, result.source, lastError),
    ]);
}

const DAY_MS = 86_400_000;

export function toView(row: DomainRow, now = Date.now()): DomainView {
  if (!row.expires_at) {
    return { ...row, daysLeft: null, level: 'unknown' };
  }
  const t = Date.parse(row.expires_at);
  if (Number.isNaN(t)) return { ...row, daysLeft: null, level: 'unknown' };

  // 按 UTC 日历日取整，避免时区导致“还剩 0 天”的抖动
  const days = Math.floor((startOfUtcDay(t) - startOfUtcDay(now)) / DAY_MS);
  const level: DomainView['level'] = days < 0 ? 'expired' : days <= 7 ? 'urgent' : days <= 30 ? 'warn' : 'ok';
  return { ...row, daysLeft: days, level };
}

function startOfUtcDay(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** 看板排序：有到期日的按剩余天数升序，其余沉底 */
export function sortViews(views: DomainView[]): DomainView[] {
  return [...views].sort((a, b) => {
    if (a.daysLeft === null && b.daysLeft === null) return a.domain.localeCompare(b.domain);
    if (a.daysLeft === null) return 1;
    if (b.daysLeft === null) return -1;
    return a.daysLeft - b.daysLeft || a.domain.localeCompare(b.domain);
  });
}

/** 表不存在时给出可读提示，而不是抛 500 */
export async function isSchemaReady(db: D1Database): Promise<boolean> {
  try {
    await db.prepare("SELECT 1 FROM domains LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
}

/**
 * 已部署的旧库自动补上新表/新列，省掉手动迁移这一步。
 * SQLite 的 ALTER TABLE ADD COLUMN 没有 IF NOT EXISTS，所以先用 PRAGMA 探测。
 * 一个 isolate 生命周期内只检测一次。
 */
let upgrade: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!upgrade) {
    upgrade = upgradeSchema(db).catch((err) => {
      console.error('schema upgrade failed', err);
    });
  }
  return upgrade;
}

async function upgradeSchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS settings (
         key        TEXT PRIMARY KEY,
         value      TEXT NOT NULL,
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`
    )
    .run();

  const info = await db.prepare('PRAGMA table_info(domains)').all<{ name: string }>();
  const columns = (info.results ?? []).map((r) => r.name);
  // columns 为空说明还没建过表，交给 schema.sql，别在这里 ALTER
  if (columns.length && !columns.includes('cost')) {
    await db.prepare('ALTER TABLE domains ADD COLUMN cost REAL').run();
  }
}

export async function readSettings(db: D1Database): Promise<Map<string, string>> {
  try {
    const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
    return new Map((results ?? []).map((r) => [r.key, r.value]));
  } catch {
    return new Map(); // settings 表还不存在时退化为纯 env 配置
  }
}

export async function writeSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value)
    .run();
}

export async function deleteSetting(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?1').bind(key).run();
}
