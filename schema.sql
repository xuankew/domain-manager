-- Domain Manager schema (D1 / SQLite)
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS domains (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  domain        TEXT    NOT NULL UNIQUE,
  platform      TEXT    NOT NULL DEFAULT '',   -- 用户标注的注册商，如 阿里云 / Namecheap
  note          TEXT    NOT NULL DEFAULT '',
  auto_renew    INTEGER NOT NULL DEFAULT 0,    -- 用户手动标记，仅展示用
  notify        INTEGER NOT NULL DEFAULT 1,
  cost          REAL,                          -- 年成本，手动填写；NULL = 未填
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  -- 最近一次检查的快照，冗余存储以便看板一次查询渲染
  expires_at    TEXT,
  registered_at TEXT,                          -- 注册局记录的首次注册日期（购买/创建时间）
  registrar     TEXT,
  source        TEXT,                          -- rdap | whois | error
  checked_at    TEXT,
  last_error    TEXT
);

CREATE INDEX IF NOT EXISTS idx_domains_expires ON domains(expires_at);

-- 每次检查追加一条，保留历史用于观察续费是否生效
CREATE TABLE IF NOT EXISTS checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  domain      TEXT    NOT NULL,
  checked_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT,
  registrar   TEXT,
  source      TEXT,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_checks_domain ON checks(domain, checked_at DESC);

-- 通知去重：同一到期日 + 同一阈值只发一次；续费后 expires_at 变化会重新触发
CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  domain      TEXT    NOT NULL,
  threshold   INTEGER NOT NULL,
  expires_at  TEXT    NOT NULL,
  sent_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(domain, threshold, expires_at)
);

-- RDAP bootstrap 与 whois 服务器映射缓存
CREATE TABLE IF NOT EXISTS cache (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  INTEGER NOT NULL                 -- unix epoch seconds
);

-- 页面上可改的配置。Workers 的 Secret 运行时只读，所以除 DISABLE_AUTH 外
-- 的配置都以这里为准，env Secret 仅作首次部署的引导值。
-- admin_password 存 PBKDF2 哈希，不存明文；webhook_url 是明文（含平台 token），
-- 界面上打码显示。
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
