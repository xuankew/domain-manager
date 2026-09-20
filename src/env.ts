/**
 * Workers 的绑定与 Secret。
 *
 * 除 `DB` 和 `DISABLE_AUTH` 外，其余 Secret 都只是**首次部署的引导值**：
 * 一旦在设置页保存过，D1 的 settings 表里的值优先。
 * 读取一律走 `loadSettings()`，不要直接访问 `env.WEBHOOK_URL` 之类。
 */
export interface Env {
  DB: D1Database;
  /** 看板登录密码。未设置且 D1 里也没有哈希时，看板拒绝所有访问，避免误公开 */
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
