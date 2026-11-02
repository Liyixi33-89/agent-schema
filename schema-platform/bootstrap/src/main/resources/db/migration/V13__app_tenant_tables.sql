-- M11 应用基础服务（13BE §3）：应用生命周期 / 导航树
-- 纪律：只增不改；业务删除 = 逻辑删除（status 置 DELETED/DELETING + deleted_at），永不物理删行
-- 发布记录复用 V4 已有 app_release / page_release_version（04BE §1.2）
-- 成员/角色复用 V3 已有 sys_role(role_type='APP', app_id) + sys_user_role（03BE §A.3）——不重复建表
-- 跨表引用：app.id 被 sys_role.app_id / app_release.app_id 等引用（不建物理外键——模块解耦口径，与 V2 同款纪律）

-- 应用表（13BE §3.1）
CREATE TABLE app (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL,
  name            VARCHAR(64) NOT NULL,
  icon_file_id    BIGINT,                    -- 头像/图标（file-service，文档 11）
  description     VARCHAR(512),
  theme           JSONB,                     -- {logo, primaryColor, loginBg}（主题配置消费）
  nav_tree        JSONB NOT NULL DEFAULT '[]',  -- 导航菜单树（§3.3）
  nav_version     INT NOT NULL DEFAULT 1,    -- 导航乐观并发版本（§3.3 409 NAV_VERSION_CONFLICT）
  status          VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE / ARCHIVED / DELETING
  deleted_at      TIMESTAMPTZ,
  created_by      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX idx_app_tenant ON app(tenant_id, status);

-- 维护公告（console-p1 最小支撑：单行生效公告 + 历史留存）
CREATE TABLE ops_notice (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL,
  title       VARCHAR(128) NOT NULL,
  content     VARCHAR(2048) NOT NULL,
  level       VARCHAR(16) NOT NULL DEFAULT 'INFO',   -- INFO / WARNING / CRITICAL
  active      BOOLEAN NOT NULL DEFAULT TRUE,         -- 生效开关（同租户至多一行 active）
  operator_id BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ops_notice_tenant ON ops_notice(tenant_id, active);