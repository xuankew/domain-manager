import { normalizeDomain, suffixCandidates } from './domain';
import { findRdapBase, matchBootstrapTld, rdapLookup, type Cache } from './rdap';
import { isKnownSecondLevelSuffix } from './tld';
import { findWhoisServer, whoisLookup } from './whois-lookup';
import type { LookupResult } from './types';

export interface DomainLookup extends LookupResult {
  /** 实际发起查询的域名。传入 blog.example.com 时这里是 example.com */
  queriedDomain: string;
}

/**
 * 查询单个域名的到期时间：RDAP 优先，无 RDAP 或 RDAP 不可用时回退 WHOIS(TCP 43)。
 * 到期时间来自注册局而非注册商，因此同一套逻辑覆盖阿里云、Namecheap 等任意平台。
 */
export async function lookupDomain(rawDomain: string, cache: Cache): Promise<DomainLookup> {
  const normalized = normalizeDomain(rawDomain);
  if (!normalized) {
    return {
      status: 'error',
      expiresAt: null,
      registrar: null,
      source: null,
      error: `不是合法的域名：${rawDomain}`,
      server: null,
      queriedDomain: rawDomain.trim(),
    };
  }

  const { registrable, tld } = await resolveRegistrable(normalized, cache);

  const rdap = await rdapLookup(registrable, cache);
  if (rdap?.status === 'ok' && rdap.expiresAt) return { ...rdap, queriedDomain: registrable };

  // RDAP 查不到到期日时（部分注册局会在 RDAP 里删节该字段）用 WHOIS 补齐
  const whois = await whoisLookup(registrable, tld, cache);
  if (whois?.status === 'ok' && whois.expiresAt) {
    return { ...whois, registrar: whois.registrar ?? rdap?.registrar ?? null, queriedDomain: registrable };
  }
  if (rdap?.status === 'ok') {
    return { ...rdap, expiresAt: whois?.expiresAt ?? null, queriedDomain: registrable };
  }
  if (whois?.status === 'ok') return { ...whois, queriedDomain: registrable };

  // 两条路径都没拿到有效数据时，优先返回“确定不存在”而不是笼统的错误
  if (rdap?.status === 'notfound') return { ...rdap, queriedDomain: registrable };
  if (whois?.status === 'notfound') return { ...whois, queriedDomain: registrable };

  const error = whois?.error ?? rdap?.error ?? `未找到 ${tld} 的 RDAP 或 WHOIS 服务`;
  return {
    status: 'error',
    expiresAt: null,
    registrar: null,
    source: whois?.source ?? rdap?.source ?? null,
    error,
    server: whois?.server ?? rdap?.server ?? null,
    queriedDomain: registrable,
  };
}

/**
 * 确定域名的有效 TLD 与可注册域（eTLD+1）。
 * 优先匹配已知的二级公共后缀，其次用 RDAP bootstrap（它本身就是一份 TLD 列表），
 * 最后按最长后缀逐级向 IANA 询问 WHOIS 服务器。
 */
export async function resolveRegistrable(
  domain: string,
  cache: Cache
): Promise<{ registrable: string; tld: string }> {
  const labels = domain.split('.');
  const candidates = suffixCandidates(domain); // 最长优先

  for (const suffix of candidates) {
    if (isKnownSecondLevelSuffix(suffix)) return build(labels, suffix);
  }

  const fromBootstrap = await matchBootstrapTld(domain, cache);
  if (fromBootstrap) return build(labels, fromBootstrap);

  for (const suffix of candidates) {
    if (await findWhoisServer(suffix, cache)) return build(labels, suffix);
  }

  return build(labels, labels[labels.length - 1]);
}

function build(labels: string[], tld: string): { registrable: string; tld: string } {
  const keep = Math.min(labels.length, tld.split('.').length + 1);
  return { registrable: labels.slice(labels.length - keep).join('.'), tld };
}

export { normalizeDomain };
export type { Cache, LookupResult };
export { findRdapBase };
