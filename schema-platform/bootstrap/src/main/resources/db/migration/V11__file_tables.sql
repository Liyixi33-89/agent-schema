-- M9 文件服务（11BE §4）：对象元数据表
-- 纪律：只增不改；引用与物理存储解耦（字段值存 fileId 永存，物理文件按策略清理）
CREATE TABLE file_object (
    id            BIGSERIAL PRIMARY KEY,       -- fileId
    tenant_id     BIGINT NOT NULL,
    app_id        BIGINT,
    scope         VARCHAR(32) NOT NULL,         -- attachment/import/export/artifact/avatar/template
    object_key    VARCHAR(512) NOT NULL,
    file_name     VARCHAR(255) NOT NULL,        -- 原始文件名（下载时还原，RFC 5987 编码）
    content_type  VARCHAR(128),
    size_bytes    BIGINT NOT NULL,
    sha256        VARCHAR(64),
    status        VARCHAR(16) NOT NULL,         -- PENDING(已签名未完成)/ACTIVE/EXPIRED
    uploaded_by   BIGINT,
    expire_at     TIMESTAMPTZ,                  -- 临时文件过期时间（NULL=永久）
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_file_tenant ON file_object(tenant_id, scope, created_at);
CREATE INDEX idx_file_expire ON file_object(expire_at) WHERE expire_at IS NOT NULL;

-- 分块上传会话（11BE §3.2：已传块号集合持久化 → 断点续传客户端跳过）
CREATE TABLE file_multipart_session (
    file_id       BIGINT PRIMARY KEY,
    upload_id     VARCHAR(128) NOT NULL,
    part_size     BIGINT NOT NULL,
    total_parts   INT NOT NULL,
    uploaded_parts INT[] NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
