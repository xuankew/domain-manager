import { discoverWhoisServer, isWhoisNotFound, whoisQuery } from './whois';
import { parseExpiry, parseRegistrar } from './parse';
import type { Cache } from './rdap';
import type { LookupResult } from './types';

/** 常见 ccTLD 的 WHOIS 服务器，省掉一次 IANA 往返。其余走 IANA 动态发现并缓存。 */
const KNOWN_WHOIS_SERVERS: Record<string, string> = {
  cn: 'whois.cnnic.cn',
  'com.cn': 'whois.cnnic.cn',
  'net.cn': 'whois.cnnic.cn',
  'org.cn': 'whois.cnnic.cn',
  hk: 'whois.hkirc.hk',
  tw: 'whois.twnic.net.tw',
  jp: 'whois.jprs.jp',
  'co.jp': 'whois.jprs.jp',
  uk: 'whois.nic.uk',
  'co.uk': 'whois.nic.uk',
  'org.uk': 'whois.nic.uk',
  de: 'whois.denic.de',
  fr: 'whois.nic.fr',
  it: 'whois.nic.it',
  es: 'whois.nic.es',
  nl: 'whois.domain-registry.nl',
  eu: 'whois.eu',
  ru: 'whois.tcinet.ru',
  ua: 'whois.ua',
  kr: 'whois.kr',
  sg: 'whois.sgnic.sg',
  au: 'whois.auda.org.au',
  'com.au': 'whois.auda.org.au',
  in: 'whois.registry.in',
  br: 'whois.registro.br',
  ca: 'whois.cira.ca',
  se: 'whois.iis.se',
  no: 'whois.norid.no',
  ch: 'whois.nic.ch',
  at: 'whois.nic.at',
  be: 'whois.dns.be',
  pl: 'whois.dns.pl',
  cz: 'whois.nic.cz',
  dk: 'whois.dk-hostmaster.dk',
  fi: 'whois.fi',
  gr: 'grweb.ics.forth.gr',
  il: 'whois.isoc.org.il',
  tr: 'whois.nic.tr',
  za: 'whois.registry.net.za',
  me: 'whois.nic.me',
  io: 'whois.nic.io',
  tv: 'whois.nic.tv',
  cc: 'whois.nic.cc',
  co: 'whois.nic.co',
  xyz: 'whois.nic.xyz',
  top: 'whois.nic.top',
};

const WHOIS_SERVER_TTL = 30 * 86_400;

export async function findWhoisServer(tld: string, cache: Cache): Promise<string | null> {
  const known = KNOWN_WHOIS_SERVERS[tld];
  if (known) return known;

  const key = `whois:server:${tld}`;
  const cached = await cache.get(key);
  if (cached) return cached === '-' ? null : cached;

  let server: string | null = null;
  try {
    server = await discoverWhoisServer(tld);
  } catch {
    server = null;
  }
  // 失败也缓存（'-'），避免同一个查不到的 TLD 反复打 IANA
  await cache.set(key, server ?? '-', server ? WHOIS_SERVER_TTL : 3_600);
  return server;
}

export async function whoisLookup(domain: string, tld: string, cache: Cache): Promise<LookupResult | null> {
  const server = await findWhoisServer(tld, cache);
  if (!server) return null;

  let text: string;
  try {
    text = await whoisQuery(server, domain);
  } catch (err) {
    return {
      status: 'error',
      expiresAt: null,
      registrar: null,
      source: 'whois',
      error: err instanceof Error ? err.message : String(err),
      server,
    };
  }

  if (isWhoisNotFound(text)) {
    return { status: 'notfound', expiresAt: null, registrar: null, source: 'whois', error: null, server };
  }

  const expiresAt = parseExpiry(text);
  const registrar = parseRegistrar(text);

  return {
    // 有些注册局（.de / .nl）不公开到期时间，能查到记录就算成功
    status: expiresAt || registrar ? 'ok' : 'error',
    expiresAt,
    registrar,
    source: 'whois',
    error: expiresAt || registrar ? null : '无法从 WHOIS 响应中解析出到期时间或注册商',
    server,
  };
}
