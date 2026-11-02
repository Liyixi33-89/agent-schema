-- v0.4 Cookie 会话（03BE §4.1 2026-11-02 收口）：
-- 1) pwd_version：强失效语义——改密/停用自增，access JWT claim 与库版本比对，不一致下一请求 401；
-- 2) csrf 值入会话行（schema_csrf 双提交源与 refresh 会话绑定滚动——服务端可比对头与库值）。
-- 纪律：只增不改（DDL 铁律）；既有行 pwd_version 默认 1 视为已同步。

ALTER TABLE sys_user ADD COLUMN pwd_version INT NOT NULL DEFAULT 1;

ALTER TABLE sys_refresh_token ADD COLUMN csrf_value VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE sys_refresh_token ADD COLUMN consumed_at TIMESTAMPTZ;
