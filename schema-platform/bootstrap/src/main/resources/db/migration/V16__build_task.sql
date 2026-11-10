-- M14 build-service 任务表（04BE §2.4）：同源码幂等复用产物 + 审计追溯
-- 纪律：编译失败不覆盖 contentHash（线上继续跑上一版）；source_hash 幂等键防重复产物
CREATE TABLE build_task (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     BIGINT NOT NULL,
    app_id        BIGINT,
    page_id       BIGINT,
    source_hash   VARCHAR(64) NOT NULL,       -- 源码 SHA-256（审计"哪版源码"）
    content_hash  VARCHAR(64),                -- 产物 SHA-256（成功才有；URL 即 artifacts/{tenantId}/{contentHash}.js）
    status        VARCHAR(16) NOT NULL,       -- QUEUED / RUNNING / SUCCESS / FAILED / SECURITY_BLOCKED
    errors        JSONB,                      -- CompileError 列表 [{line, column, message, code?}]
    duration_ms   INT,
    created_by    BIGINT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 同源码幂等：命中既有成功任务直接复用产物，不产生新对象（04BE §2.4）
CREATE UNIQUE INDEX idx_build_task_idem ON build_task(tenant_id, source_hash) WHERE status = 'SUCCESS';
CREATE INDEX idx_build_task_page ON build_task(tenant_id, page_id, created_at);
