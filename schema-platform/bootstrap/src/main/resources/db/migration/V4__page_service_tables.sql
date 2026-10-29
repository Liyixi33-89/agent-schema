-- M4 页面服务（04BE §1.2）：页面 Schema 存储 / 页面发布版本（不可变全量快照）/ 应用发布快照
-- 纪律：本迁移只增不改；page_release_version 同版本永不覆写（快照自包含——回滚不依赖 draft 存活）

-- 页面表（04BE §1.2）
CREATE TABLE page_schema (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL,
  app_id             BIGINT NOT NULL,
  page_key           VARCHAR(64) NOT NULL,
  name               VARCHAR(128),
  page_type          VARCHAR(16),             -- FORM / LIST / DETAIL / DASHBOARD
  model_id           BIGINT,
  path               VARCHAR(256) NOT NULL,   -- 路由路径，租户内唯一
  draft              JSONB NOT NULL,          -- 设计器编辑态
  draft_version      INT NOT NULL,            -- 草稿版本（自动保存/手动保存点递增）
  published          JSONB,                   -- 运行时读取态（未发布为 NULL）
  published_version  INT,                     -- ETag/If-None-Match 用
  artifact_hash      VARCHAR(64),             -- 自定义代码产物 SHA-256（对外契约名 contentHash）
  schema_etag        VARCHAR(64),             -- = published_version 的 hash
  status             VARCHAR(16) NOT NULL,    -- ACTIVE / DELETED
  updated_by         BIGINT,
  updated_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, app_id, page_key)
);
CREATE INDEX idx_page_path ON page_schema(tenant_id, path);
CREATE INDEX idx_page_app ON page_schema(tenant_id, app_id, status);

-- 页面发布版本（不可变，发布时全量落库——快照可恢复的唯一真源，04BE §1.2 2026-10-28 修正）
CREATE TABLE page_release_version (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL,
  app_id        BIGINT NOT NULL,
  page_id       BIGINT NOT NULL,
  page_version  INT NOT NULL,                 -- 对应页面 published_version
  schema        JSONB NOT NULL,               -- 完整 PageSchema 全量快照
  artifact_hash VARCHAR(64),                  -- 轨道 B 产物 hash（纯 Schema 页面为 NULL）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (page_id, page_version)              -- 不可变：同版本永不覆写
);

-- 发布快照（应用级，发布时聚合页面/模型引用/产物hash）
CREATE TABLE app_release (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL,
  app_id          BIGINT NOT NULL,
  release_version INT NOT NULL,
  snapshot        JSONB NOT NULL,             -- {pages:[{pageId, pageVersionRef, schemaVersion, contentHash}], modelRefs:[...]}
  changelog       JSONB,
  operator_id     BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          VARCHAR(16),                -- ACTIVE / ROLLED_BACK
  UNIQUE (app_id, release_version)
);

-- 预览凭证（04BE §A.7）：grant 5 分钟单次 + 预览会话登记（吊销闭环数据面）
-- 本地无 Redis：grant/会话以库表落地语义等价（条件 UPDATE 一次性消费），Redis 化随 M5
CREATE TABLE page_preview_grant (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL,
  app_id          BIGINT NOT NULL,
  page_id         BIGINT,                     -- 可空：应用级预览
  grant_uuid      VARCHAR(64) NOT NULL,       -- grantId（UUID v4，不可预测）
  issuer_id       BIGINT NOT NULL,            -- 发起人（权限 = 发起人 ∩ 预览范围）
  allow_real_write BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at      TIMESTAMPTZ NOT NULL,       -- 5 分钟
  consumed_at     TIMESTAMPTZ,                -- exchange 后即毁（重放 401 GRANT_CONSUMED）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (grant_uuid)
);
CREATE INDEX idx_preview_grant_app ON page_preview_grant(tenant_id, app_id, consumed_at);

-- 预览会话（exchange 产物）：吊销 = 删行 → 下一请求 401 PREVIEW_SESSION_REVOKED
CREATE TABLE page_preview_session (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL,
  app_id          BIGINT NOT NULL,
  page_id         BIGINT,
  session_uuid    VARCHAR(64) NOT NULL,       -- accessToken 内嵌 previewSessionId claim（JTI 同值）
  grant_id        BIGINT NOT NULL,
  issuer_id       BIGINT NOT NULL,
  allow_real_write BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at      TIMESTAMPTZ NOT NULL,       -- 15 分钟
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_uuid)
);
CREATE INDEX idx_preview_session_app ON page_preview_session(tenant_id, app_id, revoked_at);
