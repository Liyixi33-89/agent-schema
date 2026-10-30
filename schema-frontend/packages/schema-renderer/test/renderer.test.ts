/**
 * 渲染核心单测（02FE §9 硬性要求）：
 * 双轨分派 / 字段级订阅 / DELETED 字段三路 / 错误分级 / 依赖收集。
 */
import { describe, expect, it, vi } from 'vitest';
import type { PageSchema, FieldSchema, LayoutNode } from '@schema/schema-protocol';
import {
  RenderScope, MaterialRegistry, renderLayout, extractActions,
  findDeletedFieldRefs, collectExprBindings,
} from '../src/index';

const field = (key: string, type: FieldSchema['type'], fieldStatus: FieldSchema['fieldStatus'] = 'ACTIVE'): FieldSchema => ({
  key, label: key, type, fieldStatus, sortOrder: 1,
});

const page = (layout: LayoutNode[]): PageSchema => ({
  id: 'p1', pageKey: 'p1', name: '测试页', type: 'FORM', path: '/test',
  layout, actions: [], schemaVersion: 1,
});

const node = (id: string, componentName: string, props: Record<string, unknown> = {}, children?: LayoutNode[]): LayoutNode => ({
  id, componentName, props, ...(children ? { children } : {}),
});

describe('RenderScope 字段级订阅（02FE §4）', () => {
  it('仅订阅字段变化触发对应 listener（字段级精确通知）', () => {
    const scope = new RenderScope();
    const cbA = vi.fn();
    const cbB = vi.fn();
    scope.subscribe(['amount'], cbA);
    scope.subscribe(['status'], cbB);
    scope.set('amount', 100);
    expect(scope.pendingCount).toBe(1);
    scope.set('amount', 200);
    scope.set('amount', 300);
    scope.set('amount', 300); // 同值不通知
    scope.set('status', 'draft');
    return new Promise<void>((done) => {
      queueMicrotask(() => {
        // 微任务批处理：amount 三次变化合并为一次通知
        expect(cbA).toHaveBeenCalledTimes(1);
        expect(cbB).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it('订阅组排序归一（[a,b] 与 [b,a] 同组）', () => {
    const scope = new RenderScope();
    const cb = vi.fn();
    scope.subscribe(['a', 'b'], cb);
    scope.subscribe(['b', 'a'], cb);
    scope.set('a', 1);
    return new Promise<void>((done) => {
      queueMicrotask(() => {
        // 去重：同一 listener 命中多组只触发一次
        expect(cb).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });

  it('setValues 批量写单次通知', () => {
    const scope = new RenderScope();
    const cb = vi.fn();
    scope.subscribe(['x', 'y', 'z'], cb);
    scope.setValues({ x: 1, y: 2, z: 3 });
    return new Promise<void>((done) => {
      queueMicrotask(() => {
        expect(cb).toHaveBeenCalledTimes(1);
        done();
      });
    });
  });
});

describe('渲染管线与双轨分派（02FE §2/§3）', () => {
  it('dynamic 轨道：注册物料直接产出指令；未注册产出 UnknownWidget', () => {
    const registry = new MaterialRegistry();
    registry.register({ componentName: 'TextInput', runtime: 'dynamic' });
    const ctx = {
      form: { amount: 42 },
      fields: new Map([[ 'amount', field('amount', 'number') ]]),
      registry,
    };
    const instructions = renderLayout(page([
      node('n1', 'TextInput'),
      node('n2', 'NotRegistered'),
    ]), ctx);
    expect(instructions[0].componentName).toBe('TextInput');
    expect(instructions[1].componentName).toBe('__UnknownWidget__');
  });

  it('表达式 props 求值 + 订阅收集（dependsOn 声明优先）', () => {
    const registry = new MaterialRegistry();
    registry.register({ componentName: 'LabelText', runtime: 'dynamic' });
    const ctx = {
      form: { amount: 10, discount: 0.8 },
      fields: new Map(),
      registry,
    };
    const instructions = renderLayout(page([
      node('n1', 'LabelText', {
        label: { kind: 'expr', source: 'amount * discount', dependsOn: ['amount', 'discount'] },
      }),
    ]), ctx);
    expect(instructions[0].props['label']).toBe(8);
    expect(instructions[0].subscriptions).toContain('amount');
    expect(instructions[0].subscriptions).toContain('discount');
  });

  it('L-Expr 降级：表达式错误不中断渲染（警告收集 + null 降级）', () => {
    const registry = new MaterialRegistry();
    registry.register({ componentName: 'LabelText', runtime: 'dynamic' });
    const ctx = { form: {}, fields: new Map(), registry };
    const instructions = renderLayout(page([
      node('n1', 'LabelText', {
        label: { kind: 'expr', source: 'amount *', dependsOn: ['amount'] }, // 语法错
        title: { kind: 'expr', source: 'missing_field', dependsOn: ['missing_field'] }, // 字段缺失
      }),
      node('n2', 'LabelText', { label: '正常节点' }),
    ]), ctx);
    // 错误节点降级不中断兄弟节点
    expect(instructions).toHaveLength(2);
    expect(instructions[0].props['label']).toBeNull();
    expect(instructions[0].exprWarnings.length).toBeGreaterThanOrEqual(1);
    expect(instructions[1].props['label']).toBe('正常节点');
  });

  it('DELETED 字段：fieldRef 节点运行态过滤 + 设计态标黄清单', () => {
    const registry = new MaterialRegistry();
    registry.register({ componentName: 'TextInput', runtime: 'dynamic' });
    const fields = new Map([
      ['alive', field('alive', 'text')],
      ['gone', field('gone', 'text', 'DELETED')],
    ]);
    const layout = [
      node('n1', 'TextInput', {}, undefined),
      node('n2', 'TextInput', {}, undefined),
    ];
    layout[0].fieldRef = 'alive';
    layout[1].fieldRef = 'gone';
    const instructions = renderLayout(page(layout), { form: {}, fields, registry });
    expect(instructions).toHaveLength(1);
    expect(instructions[0].nodeId).toBe('n1');
    // 设计态标黄清单
    const deleted = findDeletedFieldRefs(layout, fields);
    expect(deleted).toEqual([{ nodeId: 'n2', fieldRef: 'gone' }]);
  });

  it('extractActions：按钮 props.actions 提取动作绑定', () => {
    const actions = extractActions({
      actions: [
        { type: 'SUBMIT', successBehavior: 'TOAST' },
        { type: 'DELETE', confirmText: '确认删除？' },
        'not-an-action',
      ],
    });
    expect(actions).toHaveLength(2);
    expect(actions[0].type).toBe('SUBMIT');
  });

  it('collectExprBindings：全树依赖扫描 + 漏标推断标记', () => {
    const bindings = collectExprBindings([
      node('n1', 'LabelText', {
        a: { kind: 'expr', source: 'amount + 1', dependsOn: ['amount'] },
        b: { kind: 'expr', source: 'status', dependsOn: [] }, // 漏标
      }, [
        node('n2', 'LabelText', { c: { kind: 'expr', source: 'qty', dependsOn: ['qty'] } }),
      ]),
    ]);
    expect(bindings.size).toBe(3);
    const inferred = [...bindings.values()].filter((b) => b.inferred);
    expect(inferred).toHaveLength(1);
    expect(inferred[0].nodeId).toBe('n1');
  });
});
