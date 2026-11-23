package com.schema.flow.domain;

import java.util.List;

/**
 * 本期支持节点集（spec 021 §2 第 2 条「诚实枚举」）。
 *
 * 协议七型 ≠ 执行端全支持——本期只有 START/APPROVAL/END。
 * 其余四型（CC/CONDITION_BRANCH/PARALLEL_GATEWAY/MERGE_GATEWAY）在**发布时明确拒绝**，
 * 返回逐节点错误（NODE_TYPE_NOT_SUPPORTED），不静默忽略、不降级执行。
 */
public final class SupportedNodeTypes {

    /** 本期执行端支持节点集。 */
    public static final List<String> SUPPORTED = List.of("START", "APPROVAL", "END");

    /** 协议允许但本期不支持（用于错误提示与文档对齐）。 */
    public static final List<String> NOT_SUPPORTED_YET = List.of(
            "CC", "CONDITION_BRANCH", "PARALLEL_GATEWAY", "MERGE_GATEWAY");

    private SupportedNodeTypes() {
    }

    public static boolean isSupported(String type) {
        return SUPPORTED.contains(type);
    }
}