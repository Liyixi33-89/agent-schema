import { describe, expect, it } from 'vitest';
import { SchemaValidationError, validateFlowSchema } from '../src/validate';
import type { FlowSchema } from '../src/types';

/** 合法基准：START → APPROVAL → CONDITION_BRANCH →(2 分支) MERGE → END。 */
function baseFlow(): FlowSchema {
  return {
    flowKey: 'expense-approval', name: '报销审批', version: 1, schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'START' },
      { id: 'apr', type: 'APPROVAL', name: '主管审批', approver: { mode: 'USER', userIds: ['u1'] } },
      { id: 'br', type: 'CONDITION_BRANCH', name: '金额分支', branches: [
        { id: 'b1', label: '小额', priority: 1 },
        { id: 'b2', label: '大额', priority: 2 },
      ] },
      { id: 'mg', type: 'MERGE_GATEWAY' },
      { id: 'end', type: 'END' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'apr' },
      { id: 'e2', from: 'apr', to: 'br' },
      { id: 'e3', from: 'br', to: 'mg', branchId: 'b1' },
      { id: 'e4', from: 'br', to: 'mg', branchId: 'b2' },
      { id: 'e5', from: 'mg', to: 'end' },
    ],
  };
}

function expectReject(flow: unknown, anchor: string) {
  try {
    validateFlowSchema(flow);
  } catch (e) {
    expect(e).toBeInstanceOf(SchemaValidationError);
    const msg = (e as SchemaValidationError).pointers.join('；');
    expect(msg).toContain(anchor);
    return;
  }
  throw new Error(`应被拒绝但通过了: ${anchor}`);
}

describe('validateFlowSchema 合法形态', () => {
  it('基准流程通过（七型节点集全覆盖）', () => {
    const f = baseFlow();
    // 并行网关合法链：MERGE → PARALLEL →(审批/抄送) MERGE2 → END（不绕回旧节点避免成环）
    f.nodes.push(
      { id: 'pg', type: 'PARALLEL_GATEWAY' },
      { id: 'apr2', type: 'APPROVAL', name: '财务审批', approver: { mode: 'INITIATOR_SUPERVISOR' } },
      { id: 'cc', type: 'CC', approver: { mode: 'DEPT_ROLE', roleKeys: ['finance'] } },
      { id: 'mg2', type: 'MERGE_GATEWAY' },
    );
    f.nodes[5].type = 'END';           // 原 end 改为中间节点
    f.nodes.push({ id: 'end2', type: 'END' });
    f.edges.push(
      { id: 'e6', from: 'mg', to: 'pg' },
      { id: 'e7', from: 'pg', to: 'apr2' },
      { id: 'e8', from: 'pg', to: 'cc' },
      { id: 'e9', from: 'apr2', to: 'mg2' },
      { id: 'e10', from: 'cc', to: 'mg2' },
      { id: 'e11', from: 'mg2', to: 'end2' },
    );
    expect(() => validateFlowSchema(f)).not.toThrow();
  });
  it('INITIATOR_SUPERVISOR 模式（fallback 可选）', () => {
    const f = baseFlow();
    (f.nodes[1] as { approver?: unknown }).approver = { mode: 'INITIATOR_SUPERVISOR' };
    expect(() => validateFlowSchema(f)).not.toThrow();
  });
});

describe('validateFlowSchema 负例（spec 020 §4 验收 A2 全集）', () => {
  it('形态缺失', () => {
    expectReject(null, '必须为对象');
    expectReject({}, '/flowKey');
    expectReject({ flowKey: 'k', name: 'n', schemaVersion: 1, nodes: [], edges: [] }, '/nodes: 非空');
  });
  it('未知节点类型', () => {
    const f: any = baseFlow();
    f.nodes[1].type = 'MAGIC_NODE';
    expectReject(f, '未知节点类型');
  });
  it('节点 ID 重复', () => {
    const f: any = baseFlow();
    f.nodes[4].id = 'start';
    expectReject(f, '重复');
  });
  it('边端点不存在', () => {
    const f: any = baseFlow();
    f.edges[0].to = 'ghost';
    expectReject(f, '端点不存在');
  });
  it('自环边', () => {
    const f: any = baseFlow();
    f.edges[0].to = 'start';
    expectReject(f, '自环');
  });
  it('START 不唯一 / END 缺失', () => {
    const f: any = baseFlow();
    f.nodes[1].type = 'START';
    expectReject(f, 'START 节点必须恰好 1 个');
    const f2: any = baseFlow();
    f2.nodes[4].type = 'APPROVAL';
    expectReject(f2, 'END 节点至少 1 个');
  });
  it('连通性：不可达节点', () => {
    const f: any = baseFlow();
    f.nodes.push({ id: 'orphan', type: 'CC' });
    expectReject(f, '不可达');
  });
  it('循环拒绝', () => {
    const f: any = baseFlow();
    f.edges.push({ id: 'loop', from: 'mg', to: 'apr' });
    expectReject(f, '循环');
  });
  it('网关缺 MERGE 汇聚', () => {
    const f: any = baseFlow();
    f.nodes[3].type = 'CC';
    expectReject(f, '缺少 MERGE_GATEWAY 汇聚');
  });
  it('审批人规则：APPROVAL 模式非法/必填集缺失', () => {
    const f: any = baseFlow();
    f.nodes[1].approver = { mode: 'ROLE' };
    expectReject(f, '未知模式');
    const f2: any = baseFlow();
    f2.nodes[1].approver = { mode: 'USER', userIds: [] };
    expectReject(f2, 'USER 模式必填非空');
    const f3: any = baseFlow();
    f3.nodes[1].approver = { mode: 'DEPT_ROLE', roleKeys: [] };
    expectReject(f3, 'DEPT_ROLE 模式必填非空');
  });
  it('分支配对：branchId 不在集合 / 分支无出边', () => {
    const f: any = baseFlow();
    f.edges[2].branchId = 'ghost-branch';
    expectReject(f, '不在节点 branches 集合内');
    const f2: any = baseFlow();
    f2.edges[3].branchId = undefined;
    expectReject(f2, '无对应出边');
  });
});
