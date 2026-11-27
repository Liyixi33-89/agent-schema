-- V21: 流程实例记录执行版本（2026-11-27 评审修复）
--
-- ## 为什么需要
-- flow_definition.flow_schema 是**可变草稿**（保存即覆盖）。审批中心渲染实例
-- 流程图时按 flow_def_id 读当前 flowSchema —— 旧实例会配上新草稿图，
-- 节点位置/名称/分支与实例实际执行时不一致，轨迹看起来"对不上号"。
--
-- 记录"发起时用的是哪一版"后，前端可据此读对应版本快照；后端也可在
-- 详情响应里暴露该版本供排查。
--
-- ## 为什么可为空
-- 存量实例没有记录过版本（迁移前发起）。NULL 表示"未知版本"，
-- 前端降级为读当前 schema 并显式标注，而不是假装准确。

ALTER TABLE flow_instance_biz
    ADD COLUMN IF NOT EXISTS flow_def_version INTEGER;

COMMENT ON COLUMN flow_instance_biz.flow_def_version IS
    '发起时使用的流程定义版本（NULL = 迁移前的存量实例，版本未知）';

-- Flowable 侧部署版本（act_re_procdef.version_）与 flow_definition.version 对应，
-- 需要按实例查执行版本的场景可 join deployment_id。
CREATE INDEX IF NOT EXISTS idx_flow_instance_def_version
    ON flow_instance_biz (tenant_id, flow_def_id, flow_def_version);