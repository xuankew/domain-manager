/**
 * 常见的二级公共后缀（public suffix）。
 *
 * 为什么需要它：IANA 的 RDAP bootstrap 只登记注册局运营的后缀，.uk 在表里是 "uk"
 * 而不是 "co.uk"。若直接按 bootstrap 命中的标签数推断可注册域，bbc.co.uk 会被错误
 * 归约成 co.uk —— 而 co.uk 本身是 Nominet 持有的真实域名，查询会“成功”并返回
 * 完全无关的数据。bootstrap 不能当公共后缀表用。
 *
 * 这里收录主流 ccTLD 的二级后缀；未收录的走 bootstrap / IANA WHOIS 推断，
 * 对 .com、.cn 这类单级后缀的场景是准确的。
 */
const SECOND_LEVEL_SUFFIXES = new Set([
  // .uk
  'co.uk', 'org.uk', 'me.uk', 'net.uk', 'ac.uk', 'gov.uk', 'sch.uk', 'nhs.uk', 'police.uk', 'plc.uk', 'ltd.uk',
  // .au
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  // .jp
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  // .nz
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'school.nz', 'geek.nz', 'gen.nz', 'maori.nz',
  // .br
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  // .in
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'gov.in', 'ac.in', 'edu.in',
  // .cn
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  // .sg / .hk / .tw
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'gov.hk', 'idv.hk',
  'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'gov.tw', 'idv.tw',
  // .kr / .mx / .za / .tr / .ar
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 'kg.kr',
  'com.mx', 'org.mx', 'net.mx', 'edu.mx', 'gob.mx',
  'co.za', 'org.za', 'web.za', 'net.za', 'ac.za', 'gov.za',
  'com.tr', 'org.tr', 'net.tr', 'gov.tr', 'gen.tr', 'biz.tr',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar',
  // 东南亚 / 中东
  'com.my', 'net.my', 'org.my', 'edu.my', 'gov.my',
  'com.ph', 'net.ph', 'org.ph',
  'com.vn', 'net.vn', 'org.vn',
  'co.il', 'net.il', 'org.il', 'ac.il', 'gov.il', 'muni.il',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa',
  'com.eg', 'net.eg', 'org.eg', 'gov.eg',
  'co.id', 'web.id', 'my.id', 'ac.id', 'go.id', 'or.id',
  'com.pk', 'net.pk', 'org.pk',
  'co.th', 'in.th', 'ac.th', 'go.th', 'or.th',
  // 其他欧洲 / 美洲
  'com.ua', 'net.ua', 'org.ua', 'in.ua',
  'com.pe', 'net.pe', 'org.pe',
  'com.co', 'net.co', 'org.co',
  'com.ng', 'org.ng', 'gov.ng',
  'com.ec', 'net.ec', 'org.ec',
  'com.ve', 'net.ve', 'org.ve',
  'com.ru', 'net.ru', 'org.ru',
]);

export function isKnownSecondLevelSuffix(suffix: string): boolean {
  return SECOND_LEVEL_SUFFIXES.has(suffix.toLowerCase());
}
