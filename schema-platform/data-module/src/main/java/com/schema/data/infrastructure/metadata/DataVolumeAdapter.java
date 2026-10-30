package com.schema.data.infrastructure.metadata;

import com.schema.data.infrastructure.table.PhysicalTableManager;
import com.schema.metadata.domain.repository.DataVolumePort;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.stream.Collectors;

/**
 * DataVolumePort 实现（M2 尾项收口 2026-10-30）：真实扫描业务物理表。
 * 组合根装配：metadata-module 依赖本类所在 data-module——由 bootstrap 模块桥接
 * （metadata 只见端口接口，无反向依赖）。
 */
@Component
public class DataVolumeAdapter implements DataVolumePort {

    private final JdbcTemplate jdbc;
    private final PhysicalTableManager tables;

    public DataVolumeAdapter(JdbcTemplate jdbc, PhysicalTableManager tables) {
        this.jdbc = jdbc;
        this.tables = tables;
    }

    @Override
    public long countNonEmptyRows(long modelId, List<String> fieldKeys) {
        if (fieldKeys == null || fieldKeys.isEmpty()) {
            // 无数据键变更（纯新增字段）：按全表行数口径（新增列对既有行的影响面）
            if (!tables.tableExists(modelId)) {
                return 0;
            }
            Long count = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM " + PhysicalTableManager.tableName(modelId)
                            + " WHERE deleted_at IS NULL", Long.class);
            return count == null ? 0 : count;
        }
        if (!tables.tableExists(modelId)) {
            return 0;
        }
        // 键存在性条件：任一键非空。JDBC 陷阱：PG 驱动把 ? 当占位符——?| 操作符须双写 ??|
        // 数组字面量用单引号字符串（标识符白名单已在元数据层校验，双保险再转义引号）
        String keys = fieldKeys.stream()
                .map(k -> "'" + k.replace("'", "''") + "'")
                .collect(Collectors.joining(","));
        String sql = "SELECT COUNT(*) FROM " + PhysicalTableManager.tableName(modelId)
                + " WHERE deleted_at IS NULL AND data ??| ARRAY[" + keys + "]::text[]";
        try {
            Long count = jdbc.queryForObject(sql, Long.class);
            return count == null ? 0 : count;
        } catch (EmptyResultDataAccessException e) {
            return 0;
        }
    }
}
