import type { Cache } from './lookup/rdap';
import type { DomainLookup } from './lookup';

export interface DomainRow {
  id: number;
  domain: string;
  platform: string;
  note: string;
  auto_renew: number;
  notify: number;
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
  input: { domain: string; platform?: string; note?: string; autoRenew?: boolean; notify?: boolean }
): Promise<{ ok: true; row: DomainRow } | { ok: false; error: string }> {
  const existing = await getDomainByLabel(db, input.domain);
  if (existing) return { ok: false, error: `${input.domain} 已在列表中` };

  await db
    .prepare(
      `INSERT INTO domains (domain, platform, note, auto_renew, notify)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
    .bind(
      input.domain,
      input.platform ?? '',
      input.note ?? '',
      input.autoRenew ? 1 : 0,
      input.notify === false ? 0 : 1
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
  patch: Partial<{ platform: string; note: string; autoRenew: boolean; notify: boolean }>
): Promise<boolean> {
  const sets: string[] = [];
  const values: (string | number)[] = [];
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
