-- M3 权限基座（03BE §3.1/§4/§6）：用户/角色/权限点/数据范围/部门/刷新令牌/审计日志
-- 纪律：本迁移只增不改；审计表按月分区（03BE §6，保留 1 年由归档任务清理）

-- 用户表（03BE §3.1）
CREATE TABLE sys_user (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL,
  account         VARCHAR(64) NOT NULL,
  name            VARCHAR(64),
  password_hash   VARCHAR(128),            -- bcrypt
  dept_id         BIGINT,                  -- 主部门
  status          VARCHAR(16) NOT NULL,    -- ACTIVE / DISABLED
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,  -- 建号/重置后强制改密（§A.3.1）
  failed_attempts INT NOT NULL DEFAULT 0,  -- 登录失败计数（5 次锁 15 分钟，§4）
  locked_until    TIMESTAMPTZ,             -- 锁定截止时间
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, account)
);
CREATE INDEX idx_sys_user_tenant ON sys_user(tenant_id, status);

-- 角色表（03BE §3.1：TENANT 租户级 / APP 应用级）
CREATE TABLE sys_role (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL,
  code        VARCHAR(64) NOT NULL,
  name        VARCHAR(64),
  role_type   VARCHAR(16) NOT NULL,        -- TENANT / APP
  app_id      BIGINT,                      -- 应用级角色非空
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, app_id, code)
);

-- 用户-角色关联
CREATE TABLE sys_user_role (
  user_id BIGINT NOT NULL,
  role_id BIGINT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);

-- 角色-权限点（03BE §3.1：资源 × 动作）
CREATE TABLE sys_role_permission (
  role_id       BIGINT NOT NULL,
  resource_type VARCHAR(32) NOT NULL,      -- APP/PAGE/MODEL/RECORD/FIELD/ACTION/FLOW
  resource_id   BIGINT NOT NULL,           -- 资源 ID；FIELD 行资源用 model_id；ACTION 通配为 0
  action        VARCHAR(32) NOT NULL,      -- view/design/create/edit/delete/visible/editable/execute/initiate
  PRIMARY KEY (role_id, resource_type, resource_id, action)
);

-- 行级数据权限（角色 × 模型，03BE §3.3）
CREATE TABLE sys_role_data_scope (
  role_id     BIGINT NOT NULL,
  model_id    BIGINT NOT NULL,
  scope_type  VARCHAR(32) NOT NULL,        -- ALL / SELF / DEPT / DEPT_TREE / CUSTOM_EXPR
  scope_expr  TEXT,                        -- CUSTOM_EXPR 时为 L1 表达式
  PRIMARY KEY (role_id, model_id, scope_type)
);

-- 部门表（03BE §3.1：物化路径）
CREATE TABLE sys_dept (
  id        BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  parent_id BIGINT,
  path      VARCHAR(512),                  -- 物化路径 /1/5/12/
  name      VARCHAR(64),
  sort      INT NOT NULL DEFAULT 0
);

-- 刷新令牌（03BE §4：refresh 滚动签发 + 黑名单即吊销）
-- 设计：每次滚动签发写一行新记录（token 哈希主键），旧记录置 revoked；
--   未提供 Redis（M5 前不引入），黑名单语义 = revoked 标记 + 版本号比对
CREATE TABLE sys_refresh_token (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL,
  user_id    BIGINT NOT NULL,
  token_hash VARCHAR(128) NOT NULL,        -- SHA-256(refreshToken)，原文不落库
  revoked    BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_refresh_user ON sys_refresh_token(user_id);
CREATE UNIQUE INDEX uq_refresh_hash ON sys_refresh_token(token_hash);

-- 审计日志（03BE §6：操作/安全两类事件；按月分区）
-- 注：PG 分区表要求分区键含于主键/唯一约束，故主键为 (id, created_at)
CREATE TABLE sys_audit_log (
  id            BIGSERIAL,
  tenant_id     BIGINT,
  user_id       BIGINT,
  event_type    VARCHAR(32) NOT NULL,      -- LOGIN/SCHEMA_CHANGE/DATA_CHANGE/PERM_CHANGE/PUBLISH/SENSITIVE_OP/SECURITY
  resource_type VARCHAR(32),
  resource_id   VARCHAR(64),
  diff          JSONB,
  ip            VARCHAR(64),
  ua            VARCHAR(256),
  trace_id      VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
-- 初始分区：当前月 + 下月（后续由归档任务滚动建分区，M8 接入；P1 手动补）
DO $$
DECLARE
  d date := date_trunc('month', now());
BEGIN
  EXECUTE format('CREATE TABLE sys_audit_log_%s PARTITION OF sys_audit_log FOR VALUES FROM (%L) TO (%L)',
                 to_char(d, 'YYYY_MM'), d, d + interval '1 month');
  EXECUTE format('CREATE TABLE sys_audit_log_%s PARTITION OF sys_audit_log FOR VALUES FROM (%L) TO (%L)',
                 to_char(d + interval '1 month', 'YYYY_MM'), d + interval '1 month', d + interval '2 months');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
