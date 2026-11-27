package com.schema.flow.application;

/**
 * 业务记录访问校验端口（2026-11-27 授权缺口修复）。
 *
 * ## 为什么需要它
 * 流程发起与实例查看原本**只校验租户**：
 * {@code FlowInstanceService.start()} 只确认流程定义属于当前租户，
 * {@code detail()} 只按 tenant_id 查询实例。
 * 这导致同一租户内任意用户可以：
 * - 对**别人的**业务记录发起流程（记录是否存在都没校验）
 * - 读取**别人的**实例详情、审批意见与完整轨迹
 *
 * 全局认证过滤器（登录 + 租户头）不能替代资源级授权——它只回答
 * 「你是谁、属于哪个租户」，不回答「你能不能碰这条记录」。
 *
 * ## 为什么是端口
 * 行级权限的判定逻辑在 data-module（{@link com.schema.data.domain.repository.DataPermissionPort}
 * 的 scope 解析 + 动态表查询），而 flow-module 刻意保持零业务模块依赖
 * （pom 只有 platform-common，避免 data↔flow 循环依赖）。
 * 因此这里只声明契约，实现由组合根（bootstrap）装配为 {@code RecordAccessAdapter}。
 *
 * ## 默认实现
 * 未接线时使用 {@link #ALLOW_ALL}——**但这只用于「本模块单测」**：
 * bootstrap 必须装配真实实现，否则生产会退化为无校验。
 * 生产装配缺失由 {@code RecordAccessPortWiringTest} 兜底（缺 bean 即失败）。
 */
public interface RecordAccessPort {

    /**
     * 校验当前操作者能否访问指定业务记录。
     *
     * 实现方须同时确认三件事：
     * 1. 记录**确实存在**（未被删除、属于该租户）
     * 2. 记录的数据模型与传入 modelId 一致（防越权读取他人的模型数据）
     * 3. 当前用户在行级权限范围内可见（复用数据面的 scope 判定）
     *
     * @param tenantId 当前租户
     * @param userId   当前操作者
     * @param modelId  业务模型
     * @param recordId 业务记录
     * @return true 允许访问
     */
    boolean canAccess(long tenantId, long userId, long modelId, long recordId);

    /**
     * 未接线时的降级实现：全部允许。
     *
     * ⚠️ 仅用于 flow-module 自身的单元测试。bootstrap 必须装配真实实现
     * （见 {@code RecordAccessAdapter}），否则生产等于没有校验。
     */
    RecordAccessPort ALLOW_ALL = (tenantId, userId, modelId, recordId) -> true;
}