export interface Env {
  DB: D1Database;
  /** 看板登录密码。未设置时看板拒绝所有访问，避免误公开 */
  ADMIN_PASSWORD?: string;
  /** 到期通知的 Webhook 地址 */
  WEBHOOK_URL?: string;
  /** generic | dingtalk | wecom | feishu | slack */
  WEBHOOK_TYPE?: string;
  /** 提前多少天提醒，逗号分隔。默认 "30,7,1,0" */
  NOTIFY_DAYS?: string;
  /** 设为 "1" 关闭密码校验，仅用于本地调试 */
  DISABLE_AUTH?: string;
}

export function notifyThresholds(env: Env): number[] {
  const raw = (env.NOTIFY_DAYS ?? '30,7,1,0').trim();
  const parsed = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? Array.from(new Set(parsed)).sort((a, b) => b - a) : [30, 7, 1, 0];
}
