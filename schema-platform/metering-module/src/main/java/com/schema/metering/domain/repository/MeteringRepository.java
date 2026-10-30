package com.schema.metering.domain.repository;

import com.schema.metering.domain.UsageEventRecord;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 计量仓储接口（DIP）。
 */
public interface MeteringRepository {

    /** 写入明细（幂等：同 eventId 冲突行跳过——重投递只计一次）。 */
    void insertEvent(UsageEventRecord r);

    boolean eventExists(String eventId);

    // ---------- 聚合（09BE §5 覆盖写幂等） ----------

    /** 聚合指定日全量指标（含 seat.active 按用户去重特殊处理）。 */
    void aggregateDaily(LocalDate date);

    /** 读日聚合序列。 */
    List<Map<String, Object>> findDaily(long tenantId, String metric, LocalDate from, LocalDate to);

    /** 滚动 30 天活跃席位（明细重算口径，09BE §5——不存月表避免双写不一致）。 */
    long rollingActiveSeats(long tenantId, LocalDate today);

    // ---------- 席位（13BE §2.4 授权口径快照） ----------

    void upsertSeatSnapshot(long tenantId, LocalDate date, long licensedSeats);

    Optional<Long> latestLicensedSeats(long tenantId);
}
