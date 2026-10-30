package com.schema.metadata.domain.repository;

import java.util.List;

/**
 * 数据量影响分析端口（01BE §4.3）：precheck 时统计业务表真实数据量。
 * 物理表归 data-module（02BE §2）——metadata 经端口消费（组合根装配实现，防模块反向依赖）。
 */
public interface DataVolumePort {

    /**
     * 统计模型业务表中「任一指定字段键有非空值」的未删除行数。
     * 表不存在（建模后未建表窗口期）返回 0。
     */
    long countNonEmptyRows(long modelId, List<String> fieldKeys);
}
