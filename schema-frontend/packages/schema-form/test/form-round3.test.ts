/**
 * M7 三轮收口回归测试（2026-10-30）：
 * 破环构建拒绝 / 初始 effect 重算 / optionsFilter 求值 / effect 订阅通知 /
 * 隐藏字段跳过唯一校验 / 防抖唯一检查器 / 提交防重护栏。
 */
import { describe, expect, it, vi } from 'vitest';
import { FormStore } from '../src/store';
import { DebouncedUniqueChecker, SubmitGuard, UNIQUE_DEBOUNCE_MS } from '../src/debounce';
import type { FieldSchema } from '@schema/schema-protocol';

function field(over: Partial<FieldSchema> & Record<string, unknown>): FieldSchema {
  return {
    key: 'f', label: 'f', type: 'text', fieldStatus: 'ACTIVE', sortOrder: 0,
    ...over,
  } as FieldSchema;
}

describe('FormStore 构建期破环', () => {
  it('联动成环时构造抛错', () => {
    const a = field({ key: 'a', visibleWhen: { kind: 'expr', source: 'b > 0', dependsOn: ['b'] } });
    const b = field({ key: 'b', visibleWhen: { kind: 'expr', source: 'a > 0', dependsOn: ['a'] } });
    expect(() => new FormStore({ fields: [a, b] })).toThrow(/循环依赖/);
  });

  it('无环时正常构建', () => {
    const a = field({ key: 'a' });
    const b = field({ key: 'b', visibleWhen: { kind: 'expr', source: 'a > 0', dependsOn: ['a'] } });
    expect(() => new FormStore({ fields: [a, b] })).not.toThrow();
  });
});

describe('初始 effect 求值（默认值驱动）', () => {
  it('构造期默认值即触发 visibleWhen 判定', () => {
    const a = field({ key: 'a', defaultValue: 5 });
    const b = field({
      key: 'b',
      visibleWhen: { kind: 'expr', source: 'a > 0', dependsOn: ['a'] },
    });
    const store = new FormStore({ fields: [a, b] });
    expect(store.effectOf('b').visible).toBe(true);

    const a2 = field({ key: 'a', defaultValue: -1 });
    const b2 = field({
      key: 'b',
      visibleWhen: { kind: 'expr', source: 'a > 0', dependsOn: ['a'] },
    });
    const store2 = new FormStore({ fields: [a2, b2] });
    expect(store2.effectOf('b').visible).toBe(false);
  });
});

describe('optionsFilter 求值', () => {
  it('表达式产出标量允许值——静态 options 精确匹配过滤（L1 白名单主路径）', () => {
    const cat = field({
      key: 'cat',
      enumOptions: [
        { value: 'apple', label: '苹果', status: 'ACTIVE' },
        { value: 'carrot', label: '胡萝卜', status: 'ACTIVE' },
      ],
      optionsFilter: {
        kind: 'expr',
        // 白名单兼容：CONCAT 产出标量允许值
        source: "CONCAT(kind)",
        dependsOn: ['kind'],
      },
    });
    const kind = field({ key: 'kind', defaultValue: 'apple' });
    const store = new FormStore({ fields: [kind, cat] });
    // 初始求值：kind=apple → 只剩苹果
    expect(store.effectOf('cat').filteredOptions).toEqual([
      { value: 'apple', label: '苹果', status: 'ACTIVE' },
    ]);
    store.set('kind', 'carrot');
    expect(store.effectOf('cat').filteredOptions).toEqual([
      { value: 'carrot', label: '胡萝卜', status: 'ACTIVE' },
    ]);
  });

  it('标量不命中任何 option → 回落静态全量（undefined）', () => {
    const cat = field({
      key: 'cat',
      enumOptions: [
        { value: 'apple', label: '苹果', status: 'ACTIVE' },
      ],
      optionsFilter: {
        kind: 'expr',
        source: "CONCAT(kind)",
        dependsOn: ['kind'],
      },
    });
    const kind = field({ key: 'kind', defaultValue: 'unknown' });
    const store = new FormStore({ fields: [kind, cat] });
    expect(store.effectOf('cat').filteredOptions).toBeUndefined();
  });
});

describe('effect 变化订阅', () => {
  it('联动重算后通知 effect 订阅者', () => {
    const a = field({ key: 'a' });
    const b = field({ key: 'b', visibleWhen: { kind: 'expr', source: 'a > 0', dependsOn: ['a'] } });
    const store = new FormStore({ fields: [a, b] });
    const spy = vi.fn();
    store.subscribeEffects(['b'], spy);
    store.set('a', 1);
    expect(spy).toHaveBeenCalled();
  });
});

describe('隐藏字段跳过唯一校验', () => {
  it('visibleWhen=false 的 unique 字段不发起远程探测', async () => {
    const checker = vi.fn().mockResolvedValue(true);
    const a = field({ key: 'a' });
    const u = field({
      key: 'u', uniqueFlag: true,
      visibleWhen: { kind: 'expr', source: 'a > 0', dependsOn: ['a'] },
    });
    const store = new FormStore({ fields: [a, u], uniqueChecker: checker });
    store.set('a', -1);
    const err = await store.validateUnique('u', 'taken-value');
    expect(err).toBeNull();
    expect(checker).not.toHaveBeenCalled();
  });

  it('可见 unique 字段正常发起探测', async () => {
    const checker = vi.fn().mockResolvedValue(false);
    const u = field({ key: 'u', uniqueFlag: true });
    const store = new FormStore({ fields: [u], uniqueChecker: checker });
    const err = await store.validateUnique('u', 'x');
    expect(err).toBe('该值已被占用');
    expect(checker).toHaveBeenCalledWith('u', 'x');
  });
});

describe('DebouncedUniqueChecker', () => {
  it('连续触发合并为末次调用', async () => {
    vi.useFakeTimers();
    const checker = vi.fn().mockResolvedValue(true);
    const debounced = new DebouncedUniqueChecker(checker, UNIQUE_DEBOUNCE_MS);
    void debounced.check('u', 'a');
    void debounced.check('u', 'ab');
    void debounced.check('u', 'abc');
    expect(checker).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UNIQUE_DEBOUNCE_MS + 10);
    expect(checker).toHaveBeenCalledTimes(1);
    expect(checker).toHaveBeenCalledWith('u', 'abc');
    vi.useRealTimers();
  });

  it('cancelAll 清理全部待发探测', async () => {
    vi.useFakeTimers();
    const checker = vi.fn().mockResolvedValue(true);
    const debounced = new DebouncedUniqueChecker(checker, UNIQUE_DEBOUNCE_MS);
    void debounced.check('u', 'a');
    debounced.cancelAll();
    await vi.advanceTimersByTimeAsync(UNIQUE_DEBOUNCE_MS + 10);
    expect(checker).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('SubmitGuard', () => {
  it('进行中提交拦截重复进入', () => {
    const guard = new SubmitGuard();
    expect(guard.enter()).toBe(true);
    expect(guard.enter()).toBe(false);
    guard.leave();
    expect(guard.enter()).toBe(true);
  });
});
