/** 编辑内核单测（规格 A1/A2/A3 + 表达式校验）。 */
import { describe, expect, it } from 'vitest';
import type { PageSchema } from '@schema/schema-protocol';
import {
  DesignerStore, collectFieldRefs, findNode, generateDefaultLayout,
  acceptsChildren, validateDropTarget, HISTORY_LIMIT,
  checkPanelExpr, collectExprErrors, outlineOf, panelGroups, panelMaterial,
} from '../src';

function page(): PageSchema {
  return {
    id: 'p1', pageKey: 'test', name: '测试页', type: 'FORM',
    path: '/test', layout: [], actions: [], schemaVersion: 1,
  };
}

let seq = 0;
const newId = (): string => `n${++seq}`;

const node = (id: string, componentName = 'TextInput', children?: ReturnType<typeof node>[]) => ({
  id, componentName, props: {} as Record<string, never>, ...(children ? { children } : {}),
});

describe('DesignerStore 命令系统（A1）', () => {
  it('insert → undo → redo 后 doc 深比较相等', () => {
    const store = new DesignerStore(page());
    const before = JSON.stringify(store.document);
    store.execute({ type: 'insert', parentId: null, index: 0, node: node('a') }, '插入 TextInput');
    expect(store.document.layout).toHaveLength(1);
    expect(store.dirty).toBe(true);
    expect(store.undo()).toBe(true);
    expect(JSON.stringify(store.document)).toBe(before);
    expect(store.canRedo).toBe(true);
    expect(store.redo()).toBe(true);
    expect(store.document.layout[0].id).toBe('a');
  });

  it('updateProps 支持嵌套节点与 patch 合并', () => {
    const doc = page();
    doc.layout = [{ ...node('card', 'SectionCard', [node('inner')]), props: { label: '卡片' } }];
    const store = new DesignerStore(doc);
    store.execute({ type: 'updateProps', nodeId: 'inner', patch: { placeholder: '请输入' } });
    expect(findNode(store.document.layout, 'inner')!.node.props).toEqual({ placeholder: '请输入' });
    store.execute({ type: 'updateProps', nodeId: 'inner', patch: { disabled: true } });
    expect(findNode(store.document.layout, 'inner')!.node.props).toEqual({ placeholder: '请输入', disabled: true });
    store.undo();
    // undo 恢复快照——引用失效，必须重新 findNode（不能持有旧引用断言）
    expect(findNode(store.document.layout, 'inner')!.node.props).toEqual({ placeholder: '请输入' });
  });

  it('撤销栈容量 50 截断，第 51 步丢弃最旧', () => {
    const store = new DesignerStore(page());
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      store.execute({ type: 'insert', parentId: null, index: 0, node: node(`x${i}`) });
    }
    let undone = 0;
    while (store.undo()) undone++;
    expect(undone).toBe(HISTORY_LIMIT);
    // 撤销 50 步后还剩最先的 5 个节点
    expect(store.document.layout).toHaveLength(5);
  });

  it('undo 后再执行新命令清空 redo 栈', () => {
    const store = new DesignerStore(page());
    store.execute({ type: 'insert', parentId: null, index: 0, node: node('a') });
    store.undo();
    expect(store.canRedo).toBe(true);
    store.execute({ type: 'insert', parentId: null, index: 0, node: node('b') });
    expect(store.canRedo).toBe(false);
  });

  it('旧保存回执保留期间编辑，undo 回已提交快照才清 dirty', () => {
    const store = new DesignerStore(page());
    store.execute({ type: 'insert', parentId: null, index: 0, node: node('a') });
    const submitted = structuredClone(store.document);
    store.execute({ type: 'insert', parentId: null, index: 1, node: node('b') });
    store.markSaved(submitted);
    expect(store.dirty).toBe(true);
    expect(store.document.layout).toHaveLength(2);
    store.undo();
    expect(store.dirty).toBe(false);
  });

  it('markSaved 清 dirty；load 重置历史', () => {
    const store = new DesignerStore(page());
    store.execute({ type: 'insert', parentId: null, index: 0, node: node('a') });
    store.markSaved();
    expect(store.dirty).toBe(false);
    store.load(page());
    expect(store.canUndo).toBe(false);
    expect(store.dirty).toBe(false);
  });

  it('保存后修改再 undo 回基线：dirty 应为 false（回到保存基线）', () => {
    const store = new DesignerStore(page());
    store.execute({ type: 'insert', parentId: null, index: 0, node: node('a') });
    store.markSaved();
    store.execute({ type: 'insert', parentId: null, index: 1, node: node('b') });
    expect(store.dirty).toBe(true);
    store.undo();
    expect(store.dirty).toBe(false);
    // 基线前的历史（insert a）仍可撤销，但撤销后 dirty 回 true（偏离基线）
    expect(store.undo()).toBe(true);
    expect(store.dirty).toBe(true);
  });

  it('失败命令不污染历史栈且 doc 不变', () => {
    const doc = page();
    const store = new DesignerStore(doc);
    const before = JSON.stringify(store.document);
    expect(() => store.execute({ type: 'updateProps', nodeId: 'not-exist', patch: { a: 1 } })).toThrow();
    expect(JSON.stringify(store.document)).toBe(before);
    expect(store.canUndo).toBe(false);
    expect(store.dirty).toBe(false);
  });

  it('updateProps fieldRef 写协议字段而非 props；清空移除键', () => {
    const doc = page();
    doc.layout = [node('inp')];
    const store = new DesignerStore(doc);
    store.execute({ type: 'updateProps', nodeId: 'inp', patch: { fieldRef: 'amount' } });
    expect(store.document.layout[0].fieldRef).toBe('amount');
    expect(store.document.layout[0].props.fieldRef).toBeUndefined();
    store.undo();
    expect(store.document.layout[0].fieldRef).toBeUndefined();
    store.execute({ type: 'updateProps', nodeId: 'inp', patch: { fieldRef: 'x' } });
    store.execute({ type: 'updateProps', nodeId: 'inp', patch: { fieldRef: '' } });
    expect(store.document.layout[0].fieldRef).toBeUndefined();
  });

  it('moveWithin 同数组重排且可撤销', () => {
    const doc = page();
    doc.layout = [node('a'), node('b'), node('c')];
    const store = new DesignerStore(doc);
    store.execute({ type: 'moveWithin', parentId: null, fromIndex: 2, toIndex: 0 });
    expect(store.document.layout.map((n) => n.id)).toEqual(['c', 'a', 'b']);
    store.undo();
    expect(store.document.layout.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('delete 移除节点（含子树）且可撤销', () => {
    const doc = page();
    doc.layout = [{ ...node('card', 'SectionCard', [node('inner')]), props: {} }];
    const store = new DesignerStore(doc);
    store.execute({ type: 'delete', nodeId: 'card' });
    expect(store.document.layout).toHaveLength(0);
    store.undo();
    expect(findNode(store.document.layout, 'inner')).not.toBeNull();
  });

  it('任意命令序列 undo 全部后回到初始', () => {
    const store = new DesignerStore(page());
    const initial = JSON.stringify(store.document);
    store.execute({ type: 'insert', parentId: null, index: 0, node: { ...node('card', 'SectionCard', []), props: { label: 'x' } } });
    store.execute({ type: 'insert', parentId: 'card', index: 0, node: node('i1') });
    store.execute({ type: 'insert', parentId: 'card', index: 1, node: node('i2') });
    store.execute({ type: 'updateProps', nodeId: 'i1', patch: { placeholder: 'p' } });
    store.execute({ type: 'moveWithin', parentId: 'card', fromIndex: 0, toIndex: 1 });
    store.execute({ type: 'delete', nodeId: 'i2' });
    while (store.undo()) { /* 回滚到底 */ }
    expect(JSON.stringify(store.document)).toBe(initial);
  });
});

describe('落点校验负例（A2）', () => {
  const ctx = { acceptsChildren };
  const doc = (): PageSchema => {
    const p = page();
    p.layout = [{ ...node('card', 'SectionCard', [node('inner')]), props: {} }];
    return p;
  };

  it('非容器目标被拒', () => {
    const r = validateDropTarget(doc(), 'inner', ['new-node'], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('不是容器');
  });

  it('拖动节点不能进入自身', () => {
    const r = validateDropTarget(doc(), 'card', ['card'], ctx);
    expect(r.ok).toBe(false);
  });

  it('移动子树不能把祖先放进后代', () => {
    const d = doc();
    d.layout[0].children!.push({ ...node('deep', 'SectionCard', []), props: {} });
    const r = validateDropTarget(d, 'deep', ['card'], ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('子树');
  });

  it('嵌套深度超过 8 被拒', () => {
    const d = page();
    // 构造 7 层嵌套卡片，再往里放一层超限
    let cur: { id: string; componentName: string; props: Record<string, never>; children: unknown[] } = {
      id: 'L1', componentName: 'SectionCard', props: {}, children: [],
    };
    d.layout = [cur as never];
    for (let i = 2; i <= 7; i++) {
      const next = { id: `L${i}`, componentName: 'SectionCard', props: {}, children: [] };
      cur.children.push(next);
      cur = next as typeof cur;
    }
    const r = validateDropTarget(d, 'L7', ['fresh'], ctx);
    // L7 深度 7 → 新节点深度 8，未超
    expect(r.ok).toBe(true);
    const r2 = validateDropTarget(d, 'L7', ['fresh'], { ...ctx, maxDepth: 7 });
    expect(r2.ok).toBe(false);
    expect(r2.reason).toContain('深度');
  });

  it('根投放永远合法', () => {
    expect(validateDropTarget(page(), null, ['any'], ctx).ok).toBe(true);
  });
});

describe('模型生成默认页（A3）', () => {
  it('字段类型→物料映射正确，enum 过滤 DEPRECATED，required 透传 FormItem', () => {
    const fields = [
      { key: 'title', label: '标题', type: 'text', fieldStatus: 'ACTIVE', required: true, sortOrder: 0 },
      { key: 'amount', label: '金额', type: 'number', fieldStatus: 'ACTIVE', sortOrder: 1 },
      { key: 'status', label: '状态', type: 'enum', fieldStatus: 'ACTIVE', sortOrder: 2,
        enumOptions: [
          { value: 'draft', label: '草稿', status: 'ACTIVE' },
          { value: 'old', label: '旧值', status: 'DEPRECATED' },
        ] },
      { key: 'created', label: '创建日期', type: 'date', fieldStatus: 'ACTIVE', sortOrder: 3 },
      { key: 'total', label: '合计', type: 'computed', fieldStatus: 'ACTIVE', sortOrder: 4 },
    ] as never[];
    const layout = generateDefaultLayout(fields, {
      defaultWidgetFor: (t) => ({ text: 'TextInput', number: 'NumberInput', enum: 'SelectInput', date: 'DateInput', computed: 'LabelText' }[t] ?? 'TextInput'),
      newId,
    });
    expect(layout.map((n) => n.componentName)).toEqual(Array.from({ length: 5 }, () => 'FormItem'));
    expect(layout[0].props.required).toBe(true);
    expect(layout[0].children![0].fieldRef).toBe('title');
    expect(layout[0].children![0].componentName).toBe('TextInput');
    expect(layout[2].children![0].componentName).toBe('SelectInput');
    const options = layout[2].children![0].props.options as { value: string }[];
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe('draft');
    expect(layout[4].children![0].componentName).toBe('LabelText');
    // fieldRef 收集（差异检测输入）
    expect(collectFieldRefs(layout)).toEqual(new Set(['title', 'amount', 'status', 'created', 'total']));
  });
});

describe('表达式设计态校验（A6 单测面）', () => {
  it('合法表达式通过并提取 dependsOn', () => {
    const r = checkPanelExpr("{{ status === 'draft' }}");
    expect(r.ok).toBe(true);
    expect(r.dependsOn).toContain('status');
  });

  it('语法错误返回行列信息', () => {
    const r = checkPanelExpr('{{ amount > }}');
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBeTruthy();
  });

  it('未注册函数调用被拒（白名单）', () => {
    const r = checkPanelExpr('{{ eval("1+1") }}');
    expect(r.ok).toBe(false);
  });

  it('collectExprErrors 批量阻断输入', () => {
    const errors = collectExprErrors(
      { visibleWhen: '{{ ok === 1 }}', disabledWhen: '{{ bad ==}}' },
      ['visibleWhen', 'disabledWhen'],
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].key).toBe('disabledWhen');
  });

  it('空值放行（未配置表达式不阻断）', () => {
    expect(checkPanelExpr('').ok).toBe(true);
    expect(checkPanelExpr('   ').ok).toBe(true);
  });
});

describe('物料面板元数据（T3）', () => {
  it('15 物料全量登记且 componentName 与清单一致', () => {
    expect(PANEL_MATERIALS_COUNT()).toBe(15);
    for (const m of ['TextInput', 'FormItem', 'SectionCard', 'PrimaryButton', 'DataTable']) {
      expect(panelMaterial(m)).toBeDefined();
    }
  });

  it('容器白名单：FormItem/SectionCard/StepsWizard/GroupCollapse', () => {
    for (const m of ['FormItem', 'SectionCard', 'StepsWizard', 'GroupCollapse']) {
      expect(acceptsChildren(m)).toBe(true);
    }
    for (const m of ['TextInput', 'PrimaryButton', 'DataTable', 'LabelText']) {
      expect(acceptsChildren(m)).toBe(false);
    }
  });

  it('面板分组齐全（输入/布局/动作/数据/展示）', () => {
    const groups = panelGroups().map((g) => g.title);
    expect(groups).toEqual(['输入', '布局', '动作', '数据', '展示']);
  });

  it('propsSchema 含联动规则组的物料可校验表达式', () => {
    const m = panelMaterial('TextInput')!;
    const exprKeys = m.propsSchema.find((g) => g.title === '联动规则')!.fields.map((f) => f.key);
    expect(collectExprErrors({ visibleWhen: '{{ a > 1 }}' }, exprKeys)).toHaveLength(0);
  });
});

describe('大纲树（T6）', () => {
  it('深度与标签正确扁平化', () => {
    const doc = page();
    doc.layout = [
      { ...node('card', 'SectionCard', [node('inner')]), props: { label: '分组卡' } },
    ];
    const rows = outlineOf(doc.layout);
    expect(rows).toEqual([
      { id: 'card', componentName: 'SectionCard', label: '分组卡', depth: 0 },
      { id: 'inner', componentName: 'TextInput', label: 'TextInput', depth: 1 },
    ]);
  });
  it('updateScripts 整体替换且可撤销（编译成功回写唯一入口）', () => {
    const store = new DesignerStore(page());
    const scripts = [{ scriptId: 's1', hook: 'beforeSubmit' as const, contentHash: 'h1', sourceHash: 'sh1' }];
    store.execute({ type: 'updateScripts', scripts }, '绑定脚本');
    expect(store.document.scripts).toEqual(scripts);
    expect(store.dirty).toBe(true);
    store.undo();
    expect(store.document.scripts).toBeUndefined();
  });
});

import { PANEL_MATERIALS } from '../src';
function PANEL_MATERIALS_COUNT(): number { return PANEL_MATERIALS.length; }
