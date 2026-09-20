import { toIsoDate } from './parse';
import { suffixCandidates } from './domain';
import type { LookupResult } from './types';

export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL = 86_400; // IANA 每天更新，缓存一天足够
const USER_AGENT = 'domain-manager/0.1 (+https://github.com/) Cloudflare-Workers';

type Bootstrap = [string[], string[]][];

/** 返回 null 表示该 TLD 没有 RDAP 服务或查询失败，调用方应回退到 WHOIS。 */
export async function rdapLookup(domain: string, cache: Cache): Promise<LookupResult | null> {
  const baseUrl = await findRdapBase(domain, cache);
  if (!baseUrl) return null;

  const url = `${baseUrl.replace(/\/+$/, '')}/domain/${encodeURIComponent(domain)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': USER_AGENT },
      redirect: 'follow',
      // 单次查询不缓存，保证用户点“刷新”时拿到最新数据
      cf: { cacheTtl: 0 },
    } as RequestInit);
  } catch (err) {
    return null; // 网络层失败，交给 WHOIS 兜底
  }

  if (res.status === 404) {
    return {
      status: 'notfound',
      expiresAt: null,
      registeredAt: null,
      registrar: null,
      source: 'rdap',
      error: null,
      server: url,
    };
  }
  if (!res.ok) return null;

  let body: RdapObject;
  try {
    body = (await res.json()) as RdapObject;
  } catch {
    return null;
  }

  const expiresAt = extractExpiration(body);
  const registrar = extractRegistrar(body);
  const registeredAt = extractEventDate(body, 'registration');

  if (!expiresAt && !registrar) {
    // RDAP 返回了对象但没有可用字段，回退 WHOIS 试试
    return null;
  }

  return {
    status: 'ok',
    expiresAt,
    registeredAt,
    registrar,
    source: 'rdap',
    error: null,
    server: url,
  };
}

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}
interface RdapEntity {
  roles?: string[];
  handle?: string;
  vcardArray?: [string, unknown[]];
  publicIds?: { type?: string; identifier?: string }[];
}
interface RdapObject {
  events?: RdapEvent[];
  entities?: RdapEntity[];
  status?: string[];
}

function extractExpiration(body: RdapObject): string | null {
  return extractEventDate(body, 'expiration');
}

function extractEventDate(body: RdapObject, action: string): string | null {
  for (const ev of body.events ?? []) {
    if (typeof ev.eventAction === 'string' && ev.eventAction.toLowerCase() === action && ev.eventDate) {
      const iso = toIsoDate(ev.eventDate);
      if (iso) return iso;
    }
  }
  return null;
}

function extractRegistrar(body: RdapObject): string | null {
  for (const ent of body.entities ?? []) {
    if (!ent.roles?.some((r) => r.toLowerCase() === 'registrar')) continue;
    const fn = vcardField(ent, 'fn');
    if (fn) return fn.slice(0, 120);
    if (ent.handle) return ent.handle.slice(0, 120);
  }
  return null;
}

function vcardField(ent: RdapEntity, name: string): string | null {
  const entries = ent.vcardArray?.[1];
  if (!Array.isArray(entries)) return null;
  for (const item of entries) {
    if (!Array.isArray(item)) continue;
    if (item[0] === name && typeof item[3] === 'string' && item[3].trim()) return item[3].trim();
  }
  return null;
}

/** 在 IANA RDAP bootstrap 中找出域名命中的最长后缀，未命中返回 null。 */
export async function matchBootstrapTld(domain: string, cache: Cache): Promise<string | null> {
  const bootstrap = await loadBootstrap(cache);
  if (!bootstrap) return null;

  const known = new Set<string>();
  for (const [tlds] of bootstrap) for (const tld of tlds) known.add(tld);

  // suffixCandidates 已按最长优先排列，第一个命中的就是有效 TLD
  for (const suffix of suffixCandidates(domain)) {
    if (known.has(suffix)) return suffix;
  }
  return null;
}

/** 依据 IANA RDAP bootstrap 为域名找到对应注册局的 RDAP base URL。 */
export async function findRdapBase(domain: string, cache: Cache): Promise<string | null> {
  const bootstrap = await loadBootstrap(cache);
  if (!bootstrap) return null;

  for (const suffix of suffixCandidates(domain)) {
    for (const [tlds, urls] of bootstrap) {
      if (!tlds.includes(suffix)) continue;
      const https = urls.find((u) => u.startsWith('https://')) ?? urls[0];
      if (https) return https;
    }
  }
  return null;
}

async function loadBootstrap(cache: Cache): Promise<Bootstrap | null> {
  const cached = await cache.get('rdap:bootstrap');
  if (cached) {
    try {
      return JSON.parse(cached) as Bootstrap;
    } catch {
      /* 缓存损坏则重新拉取 */
    }
  }

  try {
    const res = await fetch(BOOTSTRAP_URL, {
      headers: { 'User-Agent': USER_AGENT },
      cf: { cacheTtl: BOOTSTRAP_TTL, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) return null;
    const data = (await res.json()) as { services?: Bootstrap };
    if (!Array.isArray(data.services)) return null;
    await cache.set('rdap:bootstrap', JSON.stringify(data.services), BOOTSTRAP_TTL);
    return data.services;
  } catch {
    return null;
  }
}
