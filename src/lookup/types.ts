/** 域名查询结果。source 表示数据来源，便于排查 RDAP/WHOIS 覆盖问题。 */
export type LookupSource = 'rdap' | 'whois';

export type LookupStatus = 'ok' | 'notfound' | 'error';

export interface LookupResult {
  status: LookupStatus;
  /** ISO-8601 UTC 日期，未知时为 null（部分 ccTLD 如 .de 不公开到期时间） */
  expiresAt: string | null;
  /** 注册局记录的首次注册日期，即「购买/创建时间」；不公开时为 null */
  registeredAt: string | null;
  registrar: string | null;
  source: LookupSource | null;
  /** 查询失败的原始信息 */
  error: string | null;
  /** 命中的 whois 服务器或 RDAP base URL，写进 checks 便于调试 */
  server: string | null;
}

export interface CacheEntry {
  value: string;
  expiresAt: number;
}
