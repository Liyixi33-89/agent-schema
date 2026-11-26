/**
 * 流程编辑器纯函数测试（spec 022 T1 / A2）。
 *
 * 覆盖：加节点（三型 + START 唯一）、连线合法性、删除联动、审批人三模式归一化、
 * 空白骨架、编辑期自检。全部脱离 React——编辑语义的正确性先在这里守住。
 */
import { describe, expect, it } from 'vitest';
import type { FlowSchema } from '@schema/schema-protocol';
import {
  EDITABLE_NODE_TYPES, addEdge, addNode, blankSchema, defaultApprover,
  autoWire, defaultPositionFor, editorDiagnostics, isEditableType, nextEdgeId, nextNodeId,
  normalizeApprover, removeEdge, removeNode, renameNode, setApprover,
} from '../src/editorState';

function schemaOf(nodes: FlowSchema['nodes'], edges: FlowSchema['edges'] = []): FlowSchema {
  return { flowKey: 'k', name: 'n', version: 1, schemaVersion: 1, nodes, edges };
}

describe('可编辑类型边界', () => {
  it('只允许 021 后端支持的三种节点', () => {
    expect([...EDITABLE_NODE_TYPES]).toEqual(['START', 'APPROVAL', 'END']);
  });

  it('后端不支持的四种类型不可编辑（防止设计出必然发布失败的流程）', () => {
    for (const t of ['CC', 'CONDITION_BRANCH', 'PARALLEL_GATEWAY', 'MERGE_GATEWAY']) {
      expect(isEditableType(t)).toBe(false);
    }
  });
});

describe('nextNodeId / nextEdgeId', () => {
  it('id 不冲突且可预测', () => {
    const s = schemaOf([{ id: 'start_1', type: 'START' }]);
    expect(nextNodeId(s, 'START')).toBe('start_2');
    expect(nextNodeId(s, 'APPROVAL')).toBe('approval_1');
    expect(nextNodeId(s, 'END')).toBe('end_1');
  });

  it('边 id 从 edge_1 递增', () => {
    const s = schemaOf([], [{ id: 'edge_1', from: 'a', to: 'b' }]);
    expect(nextEdgeId(s)).toBe('edge_2');
  });
});

describe('addNode', () => {
  it('加 APPROVAL 自动带默认审批人（发起人上级）', () => {
    const s = addNode(blankSchema('k', 'n'), 'APPROVAL');
    const added = s.nodes[s.nodes.length - 1];
    expect(added.type).toBe('APPROVAL');
    expect(added.approver).toEqual({ mode: 'INITIATOR_SUPERVISOR' });
  });

  it('START 全局唯一——已有则拒绝', () => {
    const s = blankSchema('k', 'n');           // 已含 start_1
    const after = addNode(s, 'START');
    expect(after.nodes.filter((n) => n.type === 'START')).toHaveLength(1);
    expect(after).toBe(s);                     // 返回原对象（未变更）
  });

  it('END 可加多个', () => {
    const after = addNode(blankSchema('k', 'n'), 'END');
    expect(after.nodes.filter((n) => n.type === 'END')).toHaveLength(2);
  });

  // ===== 自动连线（2026-11-26 修复的真实缺陷）=====
  // 原实现只加节点不连线 → 新节点孤立 → 保存时后端 422
  // 「节点不可达（approval_2 — START 出发不可达）」→ 用户「能加不能存」。

  it('加 APPROVAL 自动插入 END 之前（不产生孤立节点）', () => {
    const before = blankSchema('k', 'n');       // start→approval_1→end
    const after = addNode(before, 'APPROVAL');

    const newNode = after.nodes[after.nodes.length - 1];
    expect(newNode.type).toBe('APPROVAL');

    // 新节点必须有入边和出边
    expect(after.edges.some((e) => e.to === newNode.id), '新节点应有入边').toBe(true);
    expect(after.edges.some((e) => e.from === newNode.id), '新节点应有出边').toBe(true);

    // 边数 +1（一条被重指，一条新增）
    expect(after.edges).toHaveLength(before.edges.length + 1);
  });

  it('自动接线后所有节点从 START 可达（后端连通性校验的等价断言）', () => {
    const after = addNode(addNode(blankSchema('k', 'n'), 'APPROVAL'), 'APPROVAL');

    const start = after.nodes.find((n) => n.type === 'START')!;
    const adj = new Map<string, string[]>();
    for (const e of after.edges) {
      adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    }
    const seen = new Set<string>([start.id]);
    const queue = [start.id];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    for (const n of after.nodes) {
      expect(seen.has(n.id), `节点 ${n.id}(${n.type}) 应可达`).toBe(true);
    }
  });

  it('END 无入边时接到末端节点', () => {
    // 只留 start → approval_1，END 孤立
    const s: FlowSchema = {
      flowKey: 'k', name: 'n', version: 1, schemaVersion: 1,
      nodes: [
        { id: 'start_1', type: 'START' },
        { id: 'approval_1', type: 'APPROVAL', approver: defaultApprover() },
        { id: 'end_1', type: 'END' },
      ],
      edges: [{ id: 'e1', from: 'start_1', to: 'approval_1' }],
    };
    const after = addNode(s, 'APPROVAL');
    const newNode = after.nodes[after.nodes.length - 1];
    // 应从末端节点（approval_1）接出
    expect(after.edges.some((e) => e.from === 'approval_1' && e.to === newNode.id)).toBe(true);
  });

  it('加 START/END 不自动接线（端点半自动接会破坏语义）', () => {
    const before = blankSchema('k', 'n');
    const afterEnd = addNode(before, 'END');
    // END 不自动接线——边数不变
    expect(afterEnd.edges).toHaveLength(before.edges.length);
  });
});

describe('defaultPositionFor', () => {
  it('空流程落在起始位置', () => {
    expect(defaultPositionFor(schemaOf([]))).toEqual({ x: 60, y: 40 });
  });

  it('非空流程落在最右列的右侧（不重叠）', () => {
    const p = defaultPositionFor(blankSchema('k', 'n'));
    expect(p.x).toBeGreaterThan(60);
    expect(p.y).toBeGreaterThanOrEqual(40);
  });
});

describe('addEdge 合法性', () => {
  const base = schemaOf([
    { id: 'start_1', type: 'START' },
    { id: 'approval_1', type: 'APPROVAL', approver: defaultApprover() },
    { id: 'end_1', type: 'END' },
  ]);

  it('合法连线被接受', () => {
    const s = addEdge(base, 'start_1', 'approval_1');
    expect(s.edges).toHaveLength(1);
    expect(s.edges[0]).toMatchObject({ from: 'start_1', to: 'approval_1' });
  });

  it('拒绝自环', () => {
    expect(addEdge(base, 'approval_1', 'approval_1')).toBe(base);
  });

  it('拒绝端点不存在', () => {
    expect(addEdge(base, 'start_1', 'nope')).toBe(base);
    expect(addEdge(base, 'nope', 'end_1')).toBe(base);
  });

  it('拒绝 END 出边与 START 入边（结构无意义）', () => {
    expect(addEdge(base, 'end_1', 'start_1')).toBe(base);
    expect(addEdge(base, 'approval_1', 'start_1')).toBe(base);
    expect(addEdge(base, 'end_1', 'approval_1')).toBe(base);
  });

  it('拒绝重复边', () => {
    const once = addEdge(base, 'start_1', 'approval_1');
    expect(addEdge(once, 'start_1', 'approval_1')).toBe(once);
  });
});

describe('removeNode / removeEdge', () => {
  it('删节点连带删相关边（不留悬空边）', () => {
    const s = addEdge(blankSchema('k', 'n'), 'start_1', 'end_1');
    const after = removeNode(s, 'start_1');
    expect(after.nodes.map((n) => n.id)).not.toContain('start_1');
    expect(after.edges.every((e) => e.from !== 'start_1' && e.to !== 'start_1')).toBe(true);
  });

  it('删边不影响节点', () => {
    const s = blankSchema('k', 'n');
    const after = removeEdge(s, 'edge_1');
    expect(after.nodes).toHaveLength(3);
    expect(after.edges.map((e) => e.id)).not.toContain('edge_1');
  });
});

describe('renameNode', () => {
  it('只改目标节点', () => {
    const s = renameNode(blankSchema('k', 'n'), 'approval_1', '部门经理审批');
    expect(s.nodes.find((n) => n.id === 'approval_1')?.name).toBe('部门经理审批');
    expect(s.nodes.find((n) => n.id === 'start_1')?.name).toBe('开始');
  });
});

describe('审批人三模式', () => {
  it('USER 模式只保留 userIds（不残留其它模式字段）', () => {
    const s = setApprover(blankSchema('k', 'n'), 'approval_1',
      { mode: 'USER', userIds: ['7', '  ', '9'] });
    expect(s.nodes[1].approver).toEqual({ mode: 'USER', userIds: ['7', '9'] });
  });

  it('DEPT_ROLE 模式只保留 roleKeys', () => {
    const s = setApprover(blankSchema('k', 'n'), 'approval_1',
      { mode: 'DEPT_ROLE', roleKeys: ['dept_manager'] });
    expect(s.nodes[1].approver).toEqual({ mode: 'DEPT_ROLE', roleKeys: ['dept_manager'] });
  });

  it('INITIATOR_SUPERVISOR 无 fallback 时不带该字段', () => {
    const r = normalizeApprover({ mode: 'INITIATOR_SUPERVISOR', fallbackUserIds: [] });
    expect(r).toEqual({ mode: 'INITIATOR_SUPERVISOR' });
  });

  it('INITIATOR_SUPERVISOR 有 fallback 时保留', () => {
    const r = normalizeApprover({ mode: 'INITIATOR_SUPERVISOR', fallbackUserIds: ['3'] });
    expect(r).toEqual({ mode: 'INITIATOR_SUPERVISOR', fallbackUserIds: ['3'] });
  });
});

describe('blankSchema', () => {
  it('三节点两连线，APPROVAL 带默认审批人', () => {
    const s = blankSchema('my_key', '我的流程');
    expect(s.flowKey).toBe('my_key');
    expect(s.nodes).toHaveLength(3);
    expect(s.edges).toHaveLength(2);
    expect(s.nodes.find((n) => n.type === 'APPROVAL')?.approver)
      .toEqual({ mode: 'INITIATOR_SUPERVISOR' });
  });
});

describe('editorDiagnostics（编辑期自检）', () => {
  it('空白骨架无问题', () => {
    expect(editorDiagnostics(blankSchema('k', 'n'))).toEqual([]);
  });

  it('缺 END 报错', () => {
    const s = schemaOf([{ id: 'start_1', type: 'START' }]);
    expect(editorDiagnostics(s).some((m) => m.includes('结束节点'))).toBe(true);
  });

  it('多个 START 报错', () => {
    const s = schemaOf([
      { id: 'start_1', type: 'START' }, { id: 'start_2', type: 'START' },
      { id: 'end_1', type: 'END' },
    ]);
    expect(editorDiagnostics(s).some((m) => m.includes('恰好 1 个'))).toBe(true);
  });

  it('APPROVAL 缺审批人报错', () => {
    const s = schemaOf([
      { id: 'start_1', type: 'START' },
      { id: 'approval_1', type: 'APPROVAL' },     // 无 approver
      { id: 'end_1', type: 'END' },
    ]);
    expect(editorDiagnostics(s).some((m) => m.includes('未配置审批人'))).toBe(true);
  });

  it('USER 模式空名单报错（保存前就该发现）', () => {
    const s = schemaOf([
      { id: 'start_1', type: 'START' },
      { id: 'approval_1', type: 'APPROVAL', approver: { mode: 'USER', userIds: [' '] } },
      { id: 'end_1', type: 'END' },
    ]);
    expect(editorDiagnostics(s).some((m) => m.includes('指定用户为空'))).toBe(true);
  });
});