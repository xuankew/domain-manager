/**
 * 从域名生成 TLD 后缀候选，最长优先。
 * 用于同时兼容 .com 这类单级和 .co.uk 这类多级后缀。
 */
export function suffixCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < labels.length; i++) {
    out.push(labels.slice(i).join('.'));
  }
  return out; // ['co.uk', 'uk'] for a.co.uk; ['com'] for a.com
}

/** 归一化域名：小写、去协议、去路径、去尾部点、剥掉 www 之外的子域由调用方决定 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)) return null;
  // 注册的是可注册域（eTLD+1）。这里只剥 www，其余子域交给查询层容错。
  if (s.startsWith('www.')) s = s.slice(4);
  return s.length <= 253 ? s : null;
}
