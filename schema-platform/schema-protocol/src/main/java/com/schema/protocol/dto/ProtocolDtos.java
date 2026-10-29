package com.schema.protocol.dto;

import com.schema.protocol.enums.FieldType;

import java.util.List;
import java.util.Map;

/**
 * M1.4 协议 DTO 镜像（01BE §3）：与前端 schema-protocol types.ts 逐字段对应。
 *
 * 定位：保存链路反序列化后的强类型载体（02BE 元数据服务消费）；
 * 结构合法性由 SchemaValidator（JSON Schema 导出物）把关，本类不做校验——
 * 校验与表示分离，避免两套规则漂移。
 *
 * 字段语义备注（与前端注释同源）：
 *  - FieldType 创建后冻结；textarea/datetime 是控件配置不进枚举（评审稿 §7 #9 定版）
 *  - computed.persistMode：READ_TIME 读取时求值 / PERSISTED 写入时物化（02BE §3.4）
 *  - relation.cascade：FORBID / SET_NULL / CASCADE_SOFT_DELETE（01BE §4 字段状态机联动）
 */
public final class ProtocolDtos {

    private ProtocolDtos() {
    }

    public record ExpressionBinding(String kind, String source, List<String> dependsOn) {
    }

    public record EnumOption(String value, String label, String color, String status) {
    }

    public record Relation(String targetModelId, String cardinality, String cascade) {
    }

    public record Computed(ExpressionBinding expr, List<String> dependsOn, String persistMode) {
    }

    public record FieldSchema(
            String key,
            String label,
            FieldType type,
            String fieldStatus,
            Boolean required,
            Boolean uniqueFlag,
            Boolean indexed,
            Object defaultValue,
            List<EnumOption> enumOptions,
            Relation relation,
            Computed computed,
            Integer sortOrder) {
    }

    public record ModelSchema(
            String id,
            String modelKey,
            String name,
            List<FieldSchema> fields,
            Integer version,
            Integer schemaVersion) {
    }

    public record SortSpec(String field, String order) {
    }

    public record AggregateMeasure(String fieldKey, String func) {
    }

    public record AggregateGroup(String fieldKey, Integer topN) {
    }

    public record TimeBucket(String fieldKey, String interval) {
    }

    public record AggregateRequest(List<AggregateMeasure> measures, AggregateGroup group, TimeBucket timeBucket) {
    }

    /** 过滤树：叶子 {field,op,value} / 组合 {and|or:[...]}（前端 {and}/{or} 形态，网关编码转换见 02BE §3.2） */
    public sealed interface FilterNode permits LeafFilter, AndFilter, OrFilter {
    }

    public record LeafFilter(String field, String op, Object value) implements FilterNode {
    }

    public record AndFilter(List<FilterNode> and) implements FilterNode {
    }

    public record OrFilter(List<FilterNode> or) implements FilterNode {
    }

    public record Pagination(Integer page, Integer size) {
    }

    public record DataSourceBinding(
            String type,
            String modelId,
            FilterNode filter,
            List<SortSpec> sort,
            Pagination pagination,
            AggregateRequest aggregate,
            Object staticData) {
    }

    public record ActionBinding(String type, Map<String, Object> payload) {
    }

    public record LayoutNode(
            String id,
            String componentName,
            Map<String, Object> props,
            List<LayoutNode> children,
            String fieldRef) {
    }

    public record PageSchema(
            String id,
            String pageKey,
            String name,
            String type,
            String modelId,
            String path,
            List<LayoutNode> layout,
            DataSourceBinding dataSource,
            List<ActionBinding> actions,
            Integer schemaVersion) {
    }
}
