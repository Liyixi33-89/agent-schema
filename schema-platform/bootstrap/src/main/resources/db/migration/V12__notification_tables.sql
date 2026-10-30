-- M10 通知服务（12BE §2）：站内信消息模型 + 偏好 + 模板
-- 纪律：只增不改；rendered 存渲染后快照（模板后续修改不影响历史消息）
CREATE TABLE notify_message (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,
    biz_type      VARCHAR(32) NOT NULL,      -- FLOW_TODO/FLOW_DONE/FLOW_URGE/QUOTA_WARN/SECURITY_ALERT/APP_NOTICE/CUSTOM
    biz_ref_id    VARCHAR(64),
    recipient_id  BIGINT NOT NULL,
    template_key  VARCHAR(64),
    rendered      JSONB NOT NULL,            -- {title, body, jumpUrl} 渲染结果快照
    channels      JSONB NOT NULL,            -- [{channel:'INBOX', status:'DONE'}]
    status        VARCHAR(16) NOT NULL,      -- PENDING/PARTIAL/DONE/FAILED/SUPPRESSED
    read_at       TIMESTAMPTZ,
    occurred_at   TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notify_recipient ON notify_message(tenant_id, recipient_id, created_at DESC);
CREATE INDEX idx_notify_unread ON notify_message(recipient_id) WHERE read_at IS NULL;

CREATE TABLE notify_user_pref (
    user_id   BIGINT,
    tenant_id BIGINT,
    prefs     JSONB NOT NULL,                -- {"FLOW_TODO":["INBOX","IM"],"MARKETING":false}
    PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE notify_template (
    id           BIGSERIAL PRIMARY KEY,
    tenant_id    BIGINT NOT NULL,
    key          VARCHAR(64) NOT NULL,       -- 应用自定义模板 key（系统内置模板不入库——代码真源）
    title        VARCHAR(255) NOT NULL,
    body         TEXT NOT NULL,
    vars_schema  JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, key)
);

-- 频控窗口计数（12BE §5：Redis TTL 计数的本地降级实现——单机内存窗口）
CREATE TABLE notify_rate_window (
    rate_key    VARCHAR(255) PRIMARY KEY,
    window_start TIMESTAMPTZ NOT NULL,
    count       INT NOT NULL DEFAULT 0
);
