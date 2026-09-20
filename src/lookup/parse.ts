/**
 * 到期日期字段在各注册局之间毫无统一标准，只能按优先级穷举。
 * 顺序敏感：更具体的模式必须排在前面，否则 "Expiry Date" 会吃掉 "Registry Expiry Date"。
 */
const EXPIRY_PATTERNS: RegExp[] = [
  /Registry Expiry Date:\s*(.+)/i,
  /Registrar Registration Expiration Date:\s*(.+)/i,
  /Registry Expires At:\s*(.+)/i,
  /Domain Expiration Date:\s*(.+)/i,
  /Expiration Date:\s*(.+)/i,
  /Expiry Date:\s*(.+)/i,
  /Expiration Time:\s*(.+)/i, // CNNIC (.cn)
  /Expires At:\s*(.+)/i,
  /Expires On:\s*(.+)/i,
  /Domain Expires:\s*(.+)/i,
  /Expire Date:\s*(.+)/i,
  /Expire time:\s*(.+)/i,
  /Valid Until:\s*(.+)/i,
  /paid-till:\s*(.+)/i, // .ru / .su
  /expires:\s*(.+)/i, // .org / RIPE 风格
  /renewal date:\s*(.+)/i,
  /expire-date:\s*(.+)/i,
  /Renewal Date:\s*(.+)/i,
];

/**
 * 首次注册日期（购买/创建时间）。顺序敏感：
 * "Created On" 必须排在 "Created" 前面，否则短模式先命中截断值。
 */
const CREATED_PATTERNS: RegExp[] = [
  /Domain Creation Date:\s*(.+)/i,
  /Creation Date:\s*(.+)/i,
  /Registration Date:\s*(.+)/i,
  /Registration Time:\s*(.+)/i, // CNNIC (.cn)
  /Registered On:\s*(.+)/i,
  /Created On:\s*(.+)/i,
  /Created:\s*(.+)/i,
  /Registered:\s*(.+)/i,
];

const REGISTRAR_PATTERNS: RegExp[] = [
  /Sponsoring Registrar:\s*(.+)/i, // CNNIC (.cn)
  /Registrar Organization:\s*(.+)/i,
  /Registrar Name:\s*(.+)/i,
  /Registrar:\s*(.+)/i,
  /registrar-name:\s*(.+)/i,
  /Registrar\s*:\s*(.+)/i,
];

export function parseExpiry(text: string): string | null {
  for (const re of EXPIRY_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const iso = toIsoDate(m[1]);
    if (iso) return iso;
  }
  return null;
}

export function parseCreated(text: string): string | null {
  for (const re of CREATED_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const iso = toIsoDate(m[1]);
    if (iso) return iso;
  }
  return null;
}

export function parseRegistrar(text: string): string | null {
  for (const re of REGISTRAR_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const value = clean(m[1]);
    // 排除 "Registrar: " 后跟 URL 或 "Registrar WHOIS Server" 之类误匹配
    if (!value || /^https?:\/\//i.test(value)) continue;
    return value.slice(0, 120);
  }
  return null;
}

function clean(s: string): string {
  return s.replace(/\r/g, '').trim().replace(/^"|"$/g, '').trim();
}

/**
 * 把五花八门的日期字符串归一成 ISO-8601 UTC。
 * "2027-10-09 04:22:59" 这类无时区的写法直接交给 Date() 会按本地时区解释，
 * 在 Worker（UTC）里虽然结果正确，但为避免歧义这里显式补 Z。
 */
export function toIsoDate(raw: string): string | null {
  let s = clean(raw);
  if (!s) return null;

  // 截断行尾附注，如 "2027-08-11T16:15:25Z (UTC)"
  s = s.replace(/\s*\(.*?\)\s*$/, '');

  // "2027-10-09 04:22:59" -> "2027-10-09T04:22:59Z"
  const plain = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (plain) s = `${plain[1]}-${plain[2]}-${plain[3]}T${plain[4]}:${plain[5]}:${plain[6] ?? '00'}Z`;

  // "2027-10-09" -> 保留为日期精度
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) s = `${s}T00:00:00Z`;

  // "09-Oct-2027" / "09 Oct 2027" 这类欧美写法
  const dmy = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4})$/);
  if (dmy) {
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    };
    const mm = months[dmy[2].toLowerCase()];
    if (mm) s = `${dmy[3]}-${mm}-${dmy[1].padStart(2, '0')}T00:00:00Z`;
  }

  // "20271009" 紧凑写法（部分 ccTLD）
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) s = `${compact[1]}-${compact[2]}-${compact[3]}T00:00:00Z`;

  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
