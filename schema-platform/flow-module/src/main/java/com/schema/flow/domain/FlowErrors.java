package com.schema.flow.domain;

/**
 * 本域错误码（spec 021 §3.6）。
 * 接口层错误处理器按 code 映射 HTTP 状态；此处只收敛常量与工厂，便于 IT 断言。
 */
public final class FlowErrors {

    private FlowErrors() {
    }

    /** 发布时含本期不支持节点（CC/CONDITION_BRANCH/PARALLEL_GATEWAY/MERGE_GATEWAY），逐节点定位。 */
    public static final String NODE_TYPE_NOT_SUPPORTED = "NODE_TYPE_NOT_SUPPORTED";
    /** 同记录同流程已有活跃实例（05BE §A.3 唯一索引拒绝）。 */
    public static final String INSTANCE_ALREADY_RUNNING = "INSTANCE_ALREADY_RUNNING";
    /** 审批意见必填。 */
    public static final String COMMENT_REQUIRED = "COMMENT_REQUIRED";
    /** 任务已被他人完成（并发办理）。 */
    public static final String TASK_ALREADY_COMPLETED = "TASK_ALREADY_COMPLETED";
    /** 任务归属校验失败（非候选人/非受理人）。 */
    public static final String TASK_NOT_ASSIGNED = "TASK_NOT_ASSIGNED";
    /** 对未发布定义发起实例。 */
    public static final String FLOW_DEF_NOT_PUBLISHED = "FLOW_DEF_NOT_PUBLISHED";
    /** 审批人解析为空 → 实例挂起（不抛调用方）。 */
    public static final String ASSIGNEE_EMPTY_BLOCKED = "ASSIGNEE_EMPTY_BLOCKED";
    /** 定义不存在（本域 404——与模型/页面域分离，防跨域线索泄漏）。 */
    public static final String FLOW_DEF_NOT_FOUND = "FLOW_DEF_NOT_FOUND";
    /** 实例不存在。 */
    public static final String INSTANCE_NOT_FOUND = "INSTANCE_NOT_FOUND";
    /** 任务不存在。 */
    public static final String TASK_NOT_FOUND = "TASK_NOT_FOUND";
    /** 定义版本冲突（草稿 baseVersion 过期）。 */
    public static final String VERSION_CONFLICT = "FLOW_VERSION_CONFLICT";

    /**
     * 资源级授权失败（2026-11-27 授权缺口修复）。
     *
     * 发起流程与查看实例都要校验「这条业务记录/实例你能碰吗」。
     * 与「记录不存在」共用同一码，避免用错误码差异探测他人数据是否存在。
     */
    public static final String FORBIDDEN = "FORBIDDEN";
    /** FlowSchema 结构非法（复用前端 validateFlowSchema 语义后的服务端兜底）。 */
    public static final String SCHEMA_INVALID = "FLOW_SCHEMA_INVALID";
    /** 转办等本期未实现能力（契约占位）。 */
    public static final String NOT_IMPLEMENTED = "FLOW_NOT_IMPLEMENTED";
}