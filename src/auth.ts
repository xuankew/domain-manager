const COOKIE_NAME = 'dm_session';
const SESSION_DAYS = 30;
const KEY_PREFIX = 'domain-manager-session-v1:';
/** 变更类接口要求带上这个头。跨站表单无法设置自定义头，配合 SameSite=Lax 抵御 CSRF。 */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'domain-manager';

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signSession(password: string, expiresAtMs: number): Promise<string> {
  const key = await hmacKey(password);
  const payload = KEY_PREFIX + expiresAtMs.toString();
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
  return `${expiresAtMs}.${toBase64Url(sig)}`;
}

export async function verifySession(token: string | undefined, password: string): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  const expiresAtMs = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) return false;

  let sig: Uint8Array;
  try {
    sig = fromBase64Url(token.slice(dot + 1));
  } catch {
    return false;
  }

  const key = await hmacKey(password);
  const payload = KEY_PREFIX + expiresAtMs.toString();
  return crypto.subtle.verify('HMAC', key, sig as unknown as BufferSource, encoder.encode(payload));
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  return crypto.subtle.timingSafeEqual(ab as unknown as BufferSource, bb as unknown as BufferSource);
}

/**
 * 密码存 D1 时只存 PBKDF2 哈希。Secret 运行时只读，页面上改密码必须落库，
 * 但库里也不该出现明文，所以走「随机盐 + 高迭代」的单向哈希。
 * 格式：pbkdf2$<iterations>$<saltB64Url>$<hashB64Url>
 */
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_BITS = 256;

async function pbkdf2Bits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    key,
    PBKDF2_BITS
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2Bits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPasswordHash(stored: string, password: string): Promise<boolean> {
  const [scheme, iterationsRaw, saltRaw, hashRaw] = stored.split('$');
  if (scheme !== 'pbkdf2' || !saltRaw || !hashRaw) return false;

  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations < 1) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64Url(saltRaw);
    expected = fromBase64Url(hashRaw);
  } catch {
    return false;
  }
  if (expected.length * 8 !== PBKDF2_BITS) return false;

  const actual = await pbkdf2Bits(password, salt, iterations);
  return crypto.subtle.timingSafeEqual(
    actual as unknown as BufferSource,
    expected as unknown as BufferSource
  );
}

export function sessionCookie(token: string): string {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86_400}`,
  ];
  // 部署在 workers.dev / 自建 HTTPS 域上都应加 Secure；本地 wrangler dev 是 http，故按协议判断
  return attrs.join('; ');
}

export function secureSessionCookie(token: string, isSecure: boolean): string {
  return isSecure ? `${sessionCookie(token)}; Secure` : sessionCookie(token);
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function issueSession(password: string, isSecure: boolean): Promise<string> {
  const token = await signSession(password, Date.now() + SESSION_DAYS * 86_400_000);
  return secureSessionCookie(token, isSecure);
}

export function readSessionCookie(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) return rest.join('=');
  }
  return undefined;
}

export { COOKIE_NAME, SESSION_DAYS };
