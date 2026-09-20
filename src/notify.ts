export interface NotifyResult {
  sent: boolean;
  error: string | null;
}

export interface WebhookTarget {
  url: string;
  type: string;
}

/**
 * 把一条到期提醒投递到 Webhook。
 * 支持钉钉 / 企业微信 / 飞书 / Slack 的字段格式，其余按 generic JSON 发送，
 * 方便接 n8n、ntfy 或自建接收端。
 * 地址与类型由调用方从设置里解析好传入（D1 优先，env 兜底）。
 */
export async function sendWebhook(target: WebhookTarget, title: string, markdown: string): Promise<NotifyResult> {
  const url = target.url.trim();
  if (!url) return { sent: false, error: null }; // 未配置即静默跳过

  const body = buildPayload(target.type, title, markdown);

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
      return { msgtype: 'markdown', markdown: { content: `### ${title}\n${markdown}` } };
    case 'feishu':
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
