package com.schema.data.infrastructure.table;

import com.schema.platform.common.tenant.TenantContext;
import com.schema.platform.common.tenant.TenantInfo;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 物理表生命周期管理器（02BE §2.1）：biz_model_<model_id> 动态建表 + 提升列 DDL。
 *
 * 铁律：
 * 1. 标识符（表名/列名）永不来自请求参数——表名由 model_id 数值拼接，列名来自 meta_field 且
 *    过 [a-z_][a-z0-9_]* 白名单正则（双保险：即使元数据被污染也无法注入 DDL）；
 * 2. 删字段/删提升列永不 DROP COLUMN（02BE §2.4——data 键与提升列永不移除）；
 * 3. 提升列唯一触发 DDL：GENERATED ALWAYS AS ... STORED（PG11+ 元数据级操作，秒级）。
 */
@Component
public class PhysicalTableManager {

    /** 列名白名单（与 meta_field.field_key 约束一致——防元数据污染注入 DDL）。 */
    private static final java.util.regex.Pattern SAFE_IDENT =
            java.util.regex.Pattern.compile("^[a-z_][a-z0-9_]{0,62}$");

    private final JdbcTemplate jdbc;

    public PhysicalTableManager(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public static String tableName(long modelId) {
        return "biz_model_" + modelId;
    }

    /** 安全列名校验：不合规直接抛（防元数据层污染传导到 DDL）。 */
    public static String safeColumn(String fieldKey) {
        if (fieldKey == null || !SAFE_IDENT.matcher(fieldKey).matches()) {
            throw new IllegalArgumentException("非法字段标识符: " + fieldKey);
        }
        return fieldKey;
    }

    /** 建表（幂等）：登记行 + 物理表二段式；含提升列时同步生成列与索引。 */
    public void ensureTable(long tenantId, long modelId,
            java.util.List<java.util.Map<String, Object>> indexedFields) {
        String table = tableName(modelId);
        // 1) 登记行（幂等水位线）
        jdbc.update("""
                INSERT INTO data_physical_table (tenant_id, model_id, table_name, status)
                VALUES (?, ?, ?, 'ACTIVE') ON CONFLICT (tenant_id, model_id)
                DO UPDATE SET updated_at = now()
                """, tenantId, modelId, table);
        // 2) 物理表（IF NOT EXISTS 幂等）
        jdbc.update("CREATE TABLE IF NOT EXISTS " + table + " ("
                + " id              BIGINT PRIMARY KEY,"
                + " tenant_id       BIGINT NOT NULL,"
                + " data            JSONB NOT NULL,"
                + " schema_version  INT NOT NULL,"
                + " created_by      BIGINT, created_at TIMESTAMPTZ DEFAULT now(),"
                + " updated_at      TIMESTAMPTZ, deleted_at TIMESTAMPTZ)");
        jdbc.update("CREATE INDEX IF NOT EXISTS idx_" + modelId + "_tenant ON "
                + table + "(tenant_id, deleted_at)");
        jdbc.update("CREATE INDEX IF NOT EXISTS idx_" + modelId + "_gin ON "
                + table + " USING GIN(data)");
        // 3) 提升列（建表时机已知的 indexed 字段一次性生成）
        for (java.util.Map<String, Object> f : indexedFields) {
            addPromotedColumn(tenantId, modelId, (String) f.get("fieldKey"),
                    (String) f.get("fieldType"));
        }
    }

    /** 提升列 DDL：GENERATED STORED + 单列索引（不锁写——小表直接建，CONCURRENTLY 随 M5.4 异步化）。 */
    public void addPromotedColumn(long tenantId, long modelId, String fieldKey, String fieldType) {
        String table = tableName(modelId);
        String col = safeColumn(fieldKey);
        String expr = switch (fieldType == null ? "text" : fieldType) {
            case "number", "computed" -> "((data->>'" + col + "')::numeric)";
            case "boolean" -> "((data->>'" + col + "')::boolean)";
            case "date" -> "((data->>'" + col + "')::timestamptz)";
            default -> "(data->>'" + col + "')";
        };
        // 列存在性预检：已存在则跳过（幂等）；GENERATED 列不可 IF NOT EXISTS（PG 限制）
        try {
            jdbc.queryForObject(
                    "SELECT 1 FROM information_schema.columns WHERE table_name=? AND column_name=?",
                    Integer.class, table, col);
            return; // 已存在
        } catch (EmptyResultDataAccessException ignored) {
            // 不存在 → 建
        }
        jdbc.update("ALTER TABLE " + table + " ADD COLUMN " + col
                + " GENERATED ALWAYS AS " + expr + " STORED");
        jdbc.update("CREATE INDEX IF NOT EXISTS idx_" + modelId + "_" + col
                + " ON " + table + "(" + col + ")");
    }

    /** 表是否已建（查询前置校验——未建表直接 404 语义）。 */
    public boolean tableExists(long modelId) {
        try {
            jdbc.queryForObject(
                    "SELECT 1 FROM information_schema.tables WHERE table_name=?",
                    Integer.class, tableName(modelId));
            return true;
        } catch (EmptyResultDataAccessException e) {
            return false;
        }
    }

    /** 表登记行状态（删模型时置 DROPPED——物理表保留归档，可恢复）。 */
    public void markDropped(long tenantId, long modelId) {
        TenantInfo t = TenantContext.get();
        jdbc.update("UPDATE data_physical_table SET status='DROPPED', updated_at=now() "
                + "WHERE tenant_id=? AND model_id=?", tenantId, modelId);
    }
}
