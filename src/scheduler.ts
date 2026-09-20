import type { Env } from './env';
import { notifyThresholds } from './env';
import { d1Cache, listDomains, saveLookup, toView, type DomainRow } from './db';
import { lookupDomain, type DomainLookup } from './lookup';
import { sendWebhook } from './notify';

/** 并发上限。注册局对 WHOIS 有速率限制，串行偏慢、并发过高会被拒。 */
const CONCURRENCY = 3;
/** 同一批次内每次查询的最小间隔（毫秒），对 whois 服务器友好一点 */
const STAGGER_MS = 250;
/** 连续失败多少次才上报，避免偶发网络抖动造成噪音 */
const FAILURE_REPORT_THRESHOLD = 3;

export interface RefreshSummary {
  total: number;
  ok: number;
  notfound: number;
  failed: number;
  ms: number;
  alerts: number;
  notifyError: string | null;
}

export async function refreshDomain(env: Env, row: DomainRow): Promise<DomainLookup> {
  const result = await lookupDomain(row.domain, d1Cache(env.DB));
  await saveLookup(env.DB, row, result);
  return result;
}

export async function refreshAll(env: Env): Promise<RefreshSummary> {
  const started = Date.now();
  const rows = await listDomains(env.DB);
  const summary: RefreshSummary = {
    total: rows.length,
    ok: 0,
    notfound: 0,
    failed: 0,
    ms: 0,
    alerts: 0,
    notifyError: null,
  };

  const queue = [...rows];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      try {
        const result = await refreshDomain(env, row);
        if (result.status === 'ok') summary.ok++;
        else if (result.status === 'notfound') summary.notfound++;
        else summary.failed++;
      } catch (err) {
        summary.failed++;
        console.error(`refresh failed for ${row.domain}`, err);
      }
      await sleep(STAGGER_MS);
    }
  });
  await Promise.all(workers);

  const alert = await dispatchAlerts(env);
  summary.alerts = alert.sent;
  summary.notifyError = alert.error;
  summary.ms = Date.now() - started;
  return summary;
}

/**
 * 检查每个域名是否跨过了某个提醒阈值，并把所有待发消息合并成一条通知。
 * 只发“刚刚跨过的那一档”：daysLeft=25 触发 30 天档，daysLeft=5 触发 7 天档，
 * 而不是把所有满足 daysLeft <= threshold 的档位一次性全发出去。
 */
export async function dispatchAlerts(env: Env): Promise<{ sent: number; error: string | null }> {
  if (!env.WEBHOOK_URL?.trim()) return { sent: 0, error: null };

  const thresholds = notifyThresholds(env).sort((a, b) => a - b);
  const rows = await listDomains(env.DB);
  const lines: string[] = [];
  const recorded: { domain: string; threshold: number; expiresAt: string }[] = [];

  for (const row of rows) {
    if (!row.notify) continue;
    const view = toView(row);
    if (view.daysLeft === null) continue;

    const applicable = thresholds.filter((t) => view.daysLeft! <= t);
    if (!applicable.length) continue;
    const threshold = applicable[0]; // thresholds 升序，第一个满足的就是最紧的一档

    const already = await env.DB.prepare(
      'SELECT 1 FROM alerts WHERE domain = ?1 AND threshold = ?2 AND expires_at = ?3'
    )
      .bind(row.domain, threshold, row.expires_at!)
      .first();
    if (already) continue;

    lines.push(formatAlertLine(view, threshold));
    recorded.push({ domain: row.domain, threshold, expiresAt: row.expires_at! });
  }

  const failures = await findPersistentFailures(env, rows);
  for (const f of failures) lines.push(`⚠️ **${f.domain}** 连续 ${f.count} 次查询失败：${f.reason}`);

  if (!lines.length) return { sent: 0, error: null };

  const title = `域名到期提醒（${lines.length} 条）`;
  const res = await sendWebhook(env, title, lines.join('\n'));

  if (res.sent) {
    // 只有真正发出去才落去重记录，发送失败下次会重试
    await env.DB.batch(
      recorded.map((r) =>
        env.DB.prepare('INSERT OR IGNORE INTO alerts (domain, threshold, expires_at) VALUES (?1, ?2, ?3)').bind(
          r.domain,
          r.threshold,
          r.expiresAt
        )
      )
    );
  }

  return { sent: res.sent ? recorded.length + failures.length : 0, error: res.error };
}

function formatAlertLine(view: ReturnType<typeof toView>, threshold: number): string {
  const date = (view.expires_at ?? '').slice(0, 10);
  const days = view.daysLeft!;
  const platform = view.platform ? `（${view.platform}）` : '';
  const renew = view.auto_renew ? ' · 已开自动续费' : '';

  if (days < 0) return `🔴 **${view.domain}**${platform} 已过期 ${Math.abs(days)} 天（${date}）${renew}`;
  if (days === 0) return `🔴 **${view.domain}**${platform} 今天到期（${date}）${renew}`;
  return `🟡 **${view.domain}**${platform} 还剩 ${days} 天，${date} 到期${renew}`;
}

async function findPersistentFailures(
  env: Env,
  rows: DomainRow[]
): Promise<{ domain: string; count: number; reason: string }[]> {
  const out: { domain: string; count: number; reason: string }[] = [];
  for (const row of rows) {
    if (!row.notify || !row.last_error) continue;
    const { results } = await env.DB.prepare(
      'SELECT error FROM checks WHERE domain = ?1 ORDER BY checked_at DESC LIMIT ?2'
    )
      .bind(row.domain, FAILURE_REPORT_THRESHOLD)
      .all<{ error: string | null }>();
    const recent = results ?? [];
    if (recent.length < FAILURE_REPORT_THRESHOLD) continue;
    if (recent.some((r) => !r.error)) continue;
    out.push({ domain: row.domain, count: recent.length, reason: row.last_error });
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
