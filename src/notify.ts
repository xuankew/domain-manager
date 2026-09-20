import type { Env } from './env';

export interface NotifyResult {
  sent: boolean;
  error: string | null;
}

/**
 * 把一条到期提醒投递到 Webhook。
 * 支持钉钉 / 企业微信 / 飞书 / Slack 的字段格式，其余按 generic JSON 发送，
 * 方便接 n8n、ntfy 或自建接收端。
 */
export async function sendWebhook(env: Env, title: string, markdown: string): Promise<NotifyResult> {
  const url = env.WEBHOOK_URL?.trim();
  if (!url) return { sent: false, error: null }; // 未配置即静默跳过

  const type = (env.WEBHOOK_TYPE ?? 'generic').trim().toLowerCase();
  const body = buildPayload(type, title, markdown);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { sent: false, error: `webhook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    return { sent: true, error: null };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function buildPayload(type: string, title: string, markdown: string): unknown {
  switch (type) {
    case 'dingtalk':
      return { msgtype: 'markdown', markdown: { title, text: `### ${title}\n${markdown}` } };
    case 'wecom':
    case 'wechat':
      return { msgtype: 'markdown', markdown: { content: `### ${title}\n${markdown}` } };
    case 'feishu':
    case 'lark':
      return { msg_type: 'text', content: { text: `${title}\n${stripMarkdown(markdown)}` } };
    case 'slack':
      return { text: `*${title}*\n${markdown}` };
    default:
      return { title, text: markdown };
  }
}

function stripMarkdown(s: string): string {
  return s.replace(/\*\*/g, '').replace(/`/g, '');
}
