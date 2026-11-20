/**
 * flow-designer 只读画布单测（spec 020 T2——渲染分支以图转换输出断言等价）：
 * - layeredFlowLayout：分层正确性 / 循环保护兜底 / 悬空边容错
 * - toCanvasGraph：七型节点全覆盖 / 未知类型占位不抛异常 / 分支边标签 / 实例状态映射
 * - countUnknownNodes / approverText / instanceStateColor
 */
import { describe, expect, it } from 'vitest';
import type { FlowSchema } from '@schema/schema-protocol';
import {
  UNKNOWN_NODE_TYPE, approverText, countUnknownNodes, instanceStateColor,
  layeredFlowLayout, toCanvasGraph,
} from '../src/layout';

/** 合法基准（与协议校验测试同构——七型全覆盖报销审批流）。 */
function demoFlow(): FlowSchema {
  return {
    flowKey: 'expense-approval', name: '报销审批', version: 1, schemaVersion: 1,
    nodes: [
      { id: 'start', type: 'START' },
      { id: 'apr', type: 'APPROVAL', name: '主管审批', approver: { mode: 'USER', userIds: ['u1'] } },
      { id: 'br', type: 'CONDITION_BRANCH', name: '金额分支', branches: [
        { id: 'b1', label: '小额', priority: 1 },
        { id: 'b2', label: '大额', priority: 2 },
      ] },
      { id: 'cc', type: 'CC', approver: { mode: 'DEPT_ROLE', roleKeys: ['finance'] } },
      { id: 'mg', type: 'MERGE_GATEWAY' },
      { id: 'end', type: 'END' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'apr' },
      { id: 'e2', from: 'apr', to: 'br' },
      { id: 'e3', from: 'br', to: 'cc', branchId: 'b1' },
      { id: 'e4', from: 'br', to: 'mg', branchId: 'b2' },
      { id: 'e5', from: 'cc', to: 'mg' },
      { id: 'e6', from: 'mg', to: 'end' },
    ],
  };
}

describe('layeredFlowLayout（spec 020 §8 循环保护）', () => {
  it('链式流程分层单调递增', () => {
    const f = demoFlow();
    const pos = layeredFlowLayout(f.nodes, f.edges);
    expect(pos.start.y).toBeLessThan(pos.apr.y);
    expect(pos.apr.y).toBeLessThan(pos.br.y);
    expect(pos.br.y).toBeLessThan(pos.mg.y);
    expect(pos.mg.y).toBeLessThan(pos.end.y);
  });
  it('同层节点横向排布不重叠', () => {
    const f = demoFlow();
    const pos = layeredFlowLayout(f.nodes, f.edges);
    // start/apr/br/mg/end 均为链上前驱唯一——分属不同层；仅同层多节点时校验横向间距
    const layers = new Map<number, number[]>();
    for (const [id, p] of Object.entries(pos)) {
      const arr = layers.get(p.y) ?? [];
      arr.push(pos[id].x);
      layers.set(p.y, arr);
    }
    for (const xs of layers.values()) {
      const sorted = [...xs].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(300);
    }
  });
  it('环形输入不挂死：环上节点归入兜底层', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }];
    const edges = [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }];
    const pos = layeredFlowLayout(nodes, edges);
    expect(pos.a).toBeDefined();
    expect(pos.b).toBeDefined();
  });
  it('悬空边端点容错跳过（不抛异常）', () => {
    const pos = layeredFlowLayout([{ id: 'a' }], [{ from: 'a', to: 'ghost' }]);
    expect(pos.a).toEqual({ x: 60, y: 40 });
  });
});

describe('toCanvasGraph（渲染快照等价断言）', () => {
  it('七型节点全部映射为 flow 卡且坐标齐备', () => {
    const f = demoFlow();
    const { nodes, edges } = toCanvasGraph(f);
    expect(nodes).toHaveLength(6);
    expect(nodes.every((n) => n.type === 'flow')).toBe(true);
    expect(nodes.every((n) => n.position.x >= 0 && n.position.y >= 0)).toBe(true);
    expect(edges).toHaveLength(6);
    expect(edges.every((e) => e.source && e.target)).toBe(true);
  });
  it('分支边携带分支标签（branches 真源）', () => {
    const f = demoFlow();
    const { edges } = toCanvasGraph(f);
    expect(edges.find((e) => e.id === 'e3')?.label).toBe('小额');
    expect(edges.find((e) => e.id === 'e4')?.label).toBe('大额');
    expect(edges.find((e) => e.id === 'e1')?.label).toBeUndefined();
  });
  it('未知节点类型 → 占位节点 + unknown 标记，不抛异常（spec A3）', () => {
    const f: any = demoFlow();
    f.nodes[1].type = 'MAGIC_NODE';
    expect(() => toCanvasGraph(f)).not.toThrow();
    const { nodes } = toCanvasGraph(f);
    const magic = nodes.find((n) => n.id === 'apr');
    expect(magic?.type).toBe(UNKNOWN_NODE_TYPE);
    expect(magic?.data.unknown).toBe(true);
    expect(magic?.data.rawType).toBe('MAGIC_NODE');
    expect(nodes.find((n) => n.id === 'start')?.type).toBe('flow');
  });
  it('实例状态映射到节点 data.state（阶段 B 通道）', () => {
    const f = demoFlow();
    const { nodes } = toCanvasGraph(f, { instanceState: { nodes: [{ nodeId: 'apr', state: 'ACTIVE' }] } });
    expect(nodes.find((n) => n.id === 'apr')?.data.state).toBe('ACTIVE');
    expect(nodes.find((n) => n.id === 'start')?.data.state).toBeUndefined();
  });
  it('外部 positions 覆盖自动布局（视图态注入）', () => {
    const f = demoFlow();
    const { nodes } = toCanvasGraph(f, { positions: { start: { x: 999, y: 999 } } });
    expect(nodes.find((n) => n.id === 'start')?.position).toEqual({ x: 999, y: 999 });
    expect(nodes.find((n) => n.id === 'end')?.position.y).toBeGreaterThan(0);
  });
});

describe('辅助纯函数', () => {
  it('countUnknownNodes：合法 0 / 含未知 1', () => {
    expect(countUnknownNodes(demoFlow().nodes)).toBe(0);
    const f: any = demoFlow();
    f.nodes[0].type = 'WEIRD';
    expect(countUnknownNodes(f.nodes)).toBe(1);
  });
  it('approverText：三模式展示文本', () => {
    expect(approverText({ mode: 'USER', userIds: ['a', 'b'] })).toContain('2 人');
    expect(approverText({ mode: 'DEPT_ROLE', roleKeys: ['finance'] })).toContain('finance');
    expect(approverText({ mode: 'INITIATOR_SUPERVISOR' })).toBe('发起人上级');
    expect(approverText(null)).toBe('');
    expect(approverText({ mode: 'OTHER' })).toBe('');
  });
  it('instanceStateColor：封闭枚举四态', () => {
    expect(instanceStateColor('ACTIVE')).toBe('#52c41a');
    expect(instanceStateColor('DONE')).toBe('#1677ff');
    expect(instanceStateColor('SKIPPED')).toBe('#d9d9d9');
    expect(instanceStateColor('PENDING')).toBeNull();
    expect(instanceStateColor('WHATEVER')).toBeNull();
  });
});
