/**
 * 演示流程 fixture（spec 020 §8——仅显式演示数据，不对不存在接口发请求）：
 * 七型节点全覆盖的报销审批流（与协议校验测试同构基准）；
 * 阶段 B 后端 flow-service 落地后由真实 GET /api/flows 替换，本文件保留作演示/回归样本。
 */
import type { FlowSchema } from '@schema/schema-protocol';

export const DEMO_FLOWS: FlowSchema[] = [
  {
    flowKey: 'expense-approval', name: '报销审批（演示）', version: 1, schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'START' },
      { id: 'apr', type: 'APPROVAL', name: '主管审批', approver: { mode: 'USER', userIds: ['u-lead'] } },
      {
        id: 'br', type: 'CONDITION_BRANCH', name: '金额分支', branches: [
          { id: 'b1', label: '小额（≤500）', priority: 1 },
          { id: 'b2', label: '大额（>500）', priority: 2 },
        ],
      },
      { id: 'cc', type: 'CC', name: '财务备案', approver: { mode: 'DEPT_ROLE', roleKeys: ['finance'] } },
      { id: 'mg', type: 'MERGE_GATEWAY' },
      { id: 'fin', type: 'APPROVAL', name: '总监审批', approver: { mode: 'INITIATOR_SUPERVISOR' } },
      { id: 'end', type: 'END' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'apr' },
      { id: 'e2', from: 'apr', to: 'br' },
      { id: 'e3', from: 'br', to: 'cc', branchId: 'b1' },
      { id: 'e4', from: 'br', to: 'mg', branchId: 'b2' },
      { id: 'e5', from: 'cc', to: 'mg' },
      { id: 'e6', from: 'mg', to: 'fin' },
      { id: 'e7', from: 'fin', to: 'end' },
    ],
  },
  {
    flowKey: 'parallel-demo', name: '并行会签（演示）', version: 1, schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'START' },
      { id: 'pg', type: 'PARALLEL_GATEWAY', name: '并行分发' },
      { id: 'a1', type: 'APPROVAL', name: '法务审核', approver: { mode: 'DEPT_ROLE', roleKeys: ['legal'] } },
      { id: 'a2', type: 'APPROVAL', name: '财务审核', approver: { mode: 'DEPT_ROLE', roleKeys: ['finance'] } },
      { id: 'mg', type: 'MERGE_GATEWAY', name: '会签汇聚' },
      { id: 'end', type: 'END' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'pg' },
      { id: 'e2', from: 'pg', to: 'a1' },
      { id: 'e3', from: 'pg', to: 'a2' },
      { id: 'e4', from: 'a1', to: 'mg' },
      { id: 'e5', from: 'a2', to: 'mg' },
      { id: 'e6', from: 'mg', to: 'end' },
    ],
  },
];
