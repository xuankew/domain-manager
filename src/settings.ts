import type { Env } from './env';
import { ensureSchema, readSettings } from './db';
import { timingSafeEqualStr, verifyPasswordHash } from './auth';

/**
 * 配置的读取层。
 *
 * Workers 的 Secret 在运行时是只读的，代码没法把页面上填的密码写回 `env.ADMIN_PASSWORD`，
 * 所以可改的配置都存 D1 的 settings 表，env Secret 只作为首次部署的引导值：
 * D1 里有记录就以 D1 为准，没有才回退到 env。
 */

export interface AppSettings {
  /** D1 里的 PBKDF2 哈希，格式 pbkdf2$iter$salt$hash */
  passwordHash: string | null;
  /** env Secret 里的明文密码，仅在尚未迁移到 D1 时生效 */
  envPassword: string | null;
  webhookUrl: string;
  webhookType: string;
  thresholds: number[];
  currency: string;
}

export const CURRENCIES = ['CNY', 'USD', 'EUR', 'JPY', 'GBP', 'HKD', 'TWD', 'KRW', 'SGD', 'AUD'] as const;

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  JPY: '¥',
  GBP: '£',
  HKD: 'HK$',
  TWD: 'NT$',
  KRW: '₩',
  SGD: 'S$',
  AUD: 'A$',
};

export const DEFAULT_CURRENCY = 'CNY';

export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code] ?? code + ' ';
}

/** 不依赖 Intl：Workers 上的 locale 数据不一定齐，千分位自己加更稳 */
function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatMoney(amount: number, currency: string): string {
  const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  const [int, dec] = value.split('.');
  return currencySymbol(currency) + groupThousands(int) + (dec ? '.' + dec : '');
}

export function normalizeCurrency(raw: unknown): string {
  const code = String(raw ?? '').trim().toUpperCase();
  return (CURRENCIES as readonly string[]).includes(code) ? code : DEFAULT_CURRENCY;
}

export const WEBHOOK_TYPES = ['generic', 'dingtalk', 'wecom', 'feishu', 'slack'] as const;

export function normalizeWebhookType(raw: unknown): string {
  const t = String(raw ?? '').trim().toLowerCase();
  // wechat / lark 是历史别名，统一收敛到规范值
  if (t === 'wechat') return 'wecom';
  if (t === 'lark') return 'feishu';
  return (WEBHOOK_TYPES as readonly string[]).includes(t) ? t : 'generic';
}

export function parseThresholds(raw: string | undefined | null): number[] {
  const parsed = String(raw ?? '')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 3650);
  return parsed.length ? Array.from(new Set(parsed)).sort((a, b) => b - a) : [30, 7, 1, 0];
}

export async function loadSettings(env: Env): Promise<AppSettings> {
  await ensureSchema(env.DB);
  const rows = await readSettings(env.DB);

  const envPassword = env.ADMIN_PASSWORD?.trim() || null;
  return {
    passwordHash: rows.get('admin_password')?.trim() || null,
    envPassword,
    webhookUrl: (rows.get('webhook_url') ?? env.WEBHOOK_URL ?? '').trim(),
    webhookType: normalizeWebhookType(rows.get('webhook_type') ?? env.WEBHOOK_TYPE),
    thresholds: parseThresholds(rows.get('notify_days') ?? env.NOTIFY_DAYS),
    currency: normalizeCurrency(rows.get('currency') ?? DEFAULT_CURRENCY),
  };
}

export type PasswordMode = 'db' | 'env' | 'none';

export function passwordMode(s: AppSettings): PasswordMode {
  if (s.passwordHash) return 'db';
  if (s.envPassword) return 'env';
  return 'none';
}

/**
 * 会话签名与 CSRF token 的密钥材料。
 * 用哈希串而不是明文：既不把明文密码扩散到更多代码路径，
 * 又保留了「改密码即让所有已登录会话失效」的行为。
 */
export function signingMaterial(s: AppSettings): string | null {
  return s.passwordHash ?? s.envPassword;
}

export async function verifyPassword(s: AppSettings, submitted: string): Promise<boolean> {
  if (s.passwordHash) return verifyPasswordHash(s.passwordHash, submitted);
  if (s.envPassword) return timingSafeEqualStr(submitted, s.envPassword);
  return false;
}
