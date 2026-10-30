/**
 * 表单引擎单测（03FE §7 硬性要求）：
 * 四联动 / visibleWhen 卸载语义 / 异步唯一性竞态 / 分步校验 / 草稿跳过 /
 * DELETED 过滤 / 提交协议服务端错误回填 / 环检测。
 */
import { describe, expect, it, vi } from 'vitest';
import type { FieldSchema } from '@schema/schema-protocol';
import { FormStore, buildReactions, executeSubmit, ServerError } from '../src/index';

const F = (key: string, ext: Partial<FieldSchema> & Record<string, unknown> = {}): FieldSchema => ({
  key, label: key, type: 'text', fieldStatus: 'ACTIVE', sortOrder: 1, ...ext,
});

const expr = (source: string, dependsOn: string[]) => ({ kind: 'expr' as const, source, dependsOn });

describe('联动编排（03FE §3）', () => {
  it('四种联动：依赖字段变化后目标字段 effect 正确变化', () => {
    const store = new FormStore({
      fields: [
        F('type'),
        F('detail', { visibleWhen: expr("type == 'A'", ['type']) }),
        F('locked', { disabledWhen: expr('type == "locked"', ['type']) }),
        F('extra', { requiredWhen: expr("type == 'strict'", ['type']) }),
      ],
    });
    store.set('type', 'A');
    expect(store.effectOf('detail').visible).toBe(true);
    expect(store.effectOf('extra').required).toBe(false);

    store.set('type', 'strict');
    expect(store.effectOf('detail').visible).toBe(false); // visibleWhen 求值 false → 卸载
    expect(store.effectOf('extra').required).toBe(true); // requiredWhen 动态必填

    store.set('type', 'locked');
    expect(store.effectOf('locked').disabled).toBe(true);
  });

  it('visibleWhen=false 字段：值不参与提交、不参与校验（03FE §5）', () => {
    const store = new FormStore({
      fields: [
        F('toggle'),
        F('secret', { required: true, visibleWhen: expr('toggle == true', ['toggle']) }),
      ],
    });
    store.setValues({ toggle: false, secret: '已有值' });
    // 卸载字段不触发必填校验
    expect(store.validate('secret')).toBeNull();
    // 序列化剔除卸载字段
    expect(store.serialize()).toEqual({ toggle: false });
    // 草稿模式保留（全量序列化）
    expect(store.serializeDraft()).toEqual({ toggle: false, secret: '已有值' });
  });

  it('环检测：循环依赖构建期识别（设计态阻断输入）', () => {
    const graph = buildReactions([
      F('a', { visibleWhen: expr('b == 1', ['b']) }),
      F('b', { visibleWhen: expr('a == 1', ['a']) }),
    ]);
    const cycle = graph.hasCycle();
    expect(cycle).not.toBeNull();
    expect(new Set(cycle)).toEqual(new Set(['a', 'b']));
  });

  it('无环图：hasCycle 返回 null', () => {
    const graph = buildReactions([
      F('a'),
      F('b', { visibleWhen: expr('a == 1', ['a']) }),
      F('c', { requiredWhen: expr('b == 1', ['b']) }),
    ]);
    expect(graph.hasCycle()).toBeNull();
  });
});

describe('校验管线（03FE §4）', () => {
  it('内置规则：required / 类型 / range / regex / enum / expression 全链', () => {
    const store = new FormStore({
      fields: [
        F('num', {
          type: 'number',
          required: true,
          validators: [
            { type: 'range', min: 0, max: 100 },
            { type: 'expression', expr: 'value >= 50' },
          ],
        } as never),
        F('code', {
          validators: [{ type: 'regex', pattern: '^[A-Z]{3}$' }],
        } as never),
        F('level', {
          type: 'enum',
          enumOptions: [
            { value: 'L1', label: '低', status: 'ACTIVE' },
            { value: 'L2', label: '高', status: 'ACTIVE' },
            { value: 'OLD', label: '弃用', status: 'DEPRECATED' },
          ],
        }),
        F('memo', { type: 'text', required: true }),
      ],
    });
    // 必填
    expect(store.validate('num')).toBe('必填项');
    // 类型 + range
    store.set('num', 10);
    expect(store.validate('num')).toBe('不符合表达式约束'); // value >= 50 拦截
    store.set('num', 60);
    expect(store.validate('num')).toBeNull();
    store.set('num', 200);
    expect(store.validate('num')).toBe('不能大于 100');
    // regex
    store.set('code', 'abc');
    expect(store.validate('code')).toBe('格式不正确');
    store.set('code', 'ABC');
    expect(store.validate('code')).toBeNull();
    // enum（DEPRECATED 选项不可选）
    store.set('level', 'OLD');
    expect(store.validate('level')).toBe('不在可选值范围');
    store.set('level', 'L1');
    expect(store.validate('level')).toBeNull();
    // 文本严格类型（后端同判——02BE §3.4）
    store.set('memo', 123 as unknown);
    expect(store.validate('memo')).toBe('须为文本值');
  });

  it('DELETED 字段：表单树构建即过滤（values 不含该字段）', () => {
    const store = new FormStore({
      fields: [
        F('alive'),
        F('gone', { fieldStatus: 'DELETED', defaultValue: 'should-not-appear' }),
      ],
    });
    expect(store.fields.has('gone')).toBe(false);
    expect(store.get('gone')).toBeUndefined();
    expect(store.serialize()).toEqual({});
  });

  it('异步唯一性竞态：last-call-wins 旧请求丢弃（03FE §4 ④）', async () => {
    let callSeq = 0;
    const results = new Map<number, boolean>();
    const store = new FormStore({
      fields: [F('code', { uniqueFlag: true })],
      uniqueChecker: async () => {
        const id = ++callSeq;
        // 第 1 次慢（占用），第 2 次快（可用）——旧慢响应必须被丢弃
        await new Promise((r) => setTimeout(r, id === 1 ? 80 : 10));
        results.set(id, true);
        return id === 1 ? false : true;
      },
    });
    const p1 = store.validateUnique('code', 'first');
    const p2 = store.validateUnique('code', 'second');
    const [r1, r2] = await Promise.all([p1, p2]);
    // 第 1 次响应（占用=false→错误）被丢弃；第 2 次（可用）生效
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(callSeq).toBe(2);
  });
});

describe('分步与提交（03FE §5 + §5 提交协议）', () => {
  const stepStore = () =>
    new FormStore({
      fields: [F('step1Field', { required: true }), F('step2Field', { required: true })],
    });

  it('步骤校验阻断下一步；全量提交校验', () => {
    const store = stepStore();
    // 步骤 1 未填 → 阻断
    expect(store.validateStep(['step1Field'])?.fieldKey).toBe('step1Field');
    store.set('step1Field', 'ok');
    expect(store.validateStep(['step1Field'])).toBeNull();
    // 步骤 2 未填 → 全量提交校验拦截
    expect(store.validateAll()?.fieldKey).toBe('step2Field');
  });

  it('提交协议：前端校验失败不出请求', async () => {
    const store = stepStore();
    const transport = { submit: vi.fn() };
    const result = await executeSubmit(store, { type: 'SUBMIT', successBehavior: 'TOAST' }, transport);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors['step1Field']).toBe('必填项');
    expect(transport.submit).not.toHaveBeenCalled();
  });

  it('提交协议：成功透传行为指令', async () => {
    const store = stepStore();
    store.setValues({ step1Field: 'a', step2Field: 'b' });
    const transport = { submit: vi.fn().mockResolvedValue({ id: 1 }) };
    const result = await executeSubmit(
      store,
      { type: 'SUBMIT', successBehavior: 'REDIRECT', redirectTo: '/done' },
      transport,
    );
    expect(result.ok).toBe(true);
    expect(result.successBehavior).toBe('REDIRECT');
    expect(result.redirectTo).toBe('/done');
    // 提交载荷剔除空值
    expect(transport.submit).toHaveBeenCalledWith({ step1Field: 'a', step2Field: 'b' });
  });

  it('提交协议：服务端字段级错误回填（422 对齐）', async () => {
    const store = stepStore();
    store.setValues({ step1Field: 'a', step2Field: 'b' });
    const transport = {
      submit: vi.fn().mockRejectedValue(
        new ServerError('VALIDATION_FAILED', '校验失败', { step2Field: '唯一字段重复' }),
      ),
    };
    const result = await executeSubmit(store, { type: 'SUBMIT', successBehavior: 'TOAST' }, transport);
    expect(result.ok).toBe(false);
    expect(result.fieldErrors['step2Field']).toBe('唯一字段重复');
    expect(result.globalError).toBe('校验失败');
  });

  it('草稿模式：跳过唯一性校验 + 全量序列化（03FE §5）', async () => {
    const uniqueChecker = vi.fn().mockResolvedValue(false); // 占用
    const store = new FormStore({
      fields: [F('code', { uniqueFlag: true })],
      uniqueChecker,
    });
    store.set('code', 'dup-value');
    const transport = { submit: vi.fn().mockResolvedValue({}) };
    const result = await executeSubmit(
      store,
      { type: 'SUBMIT', successBehavior: 'TOAST', draft: true },
      transport,
    );
    expect(result.ok).toBe(true);
    expect(uniqueChecker).not.toHaveBeenCalled();
    expect(transport.submit).toHaveBeenCalledWith({ code: 'dup-value' });
  });
});
