/**
 * 错误通道与防抖取消收口测试（2026-10-30）：
 * - publishErrors/subscribeFieldErrors 通道分发（组件订阅不依赖错误闭包的契约基础）；
 * - DebouncedUniqueChecker.cancel 级联 resolve（旧探测不留悬挂 Promise）。
 */
import { describe, expect, it, vi } from 'vitest';
import { FormStore, DebouncedUniqueChecker } from '../src';
import type { FieldSchema } from '@schema/schema-protocol';

function makeField(key: string, extra: Partial<FieldSchema> = {}): FieldSchema {
  return {
    key, label: key, type: 'text', fieldStatus: 'ACTIVE',
    required: false, uniqueFlag: false, sortOrder: 0, ...extra,
  } as FieldSchema;
}

describe('FormStore 字段错误通道', () => {
  it('publishErrors 分发 → subscribeFieldErrors 收到该字段错误', () => {
    const store = new FormStore({ fields: [makeField('name'), makeField('code')] });
    const received: (string | null)[] = [];
    store.subscribeFieldErrors('name', (m) => received.push(m));

    store.publishErrors({ name: '必填' });
    expect(received).toEqual(['必填']);

    // 其它字段错误不触发本字段订阅
    store.publishErrors({ code: '重复' });
    expect(received).toEqual(['必填']);

    // 空串清除
    store.publishErrors({ name: '' });
    expect(received).toEqual(['必填', null]);
  });

  it('重复发布相同错误不重复通知（last 判重）', () => {
    const store = new FormStore({ fields: [makeField('name')] });
    const received: (string | null)[] = [];
    store.subscribeFieldErrors('name', (m) => received.push(m));
    store.publishErrors({ name: '必填' });
    store.publishErrors({ name: '必填' });
    expect(received).toEqual(['必填']);
  });

  it('订阅退订后不再接收', () => {
    const store = new FormStore({ fields: [makeField('name')] });
    const received: (string | null)[] = [];
    const unsub = store.subscribeFieldErrors('name', (m) => received.push(m));
    store.publishErrors({ name: '必填' });
    unsub();
    store.publishErrors({ name: '另一条' });
    expect(received).toEqual(['必填']);
  });
});

describe('DebouncedUniqueChecker 取消语义', () => {
  it('连续调用顶替旧探测——旧 Promise 级联 resolve(true) 不悬挂', async () => {
    const checker = vi.fn().mockResolvedValue(false);
    const d = new DebouncedUniqueChecker(checker, 20);

    const first = d.check('code', 'A');
    const second = d.check('code', 'B');
    // 顶替后旧探测被取消——立即 resolve(true)（作废按可用）
    expect(await first).toBe(true);
    // 末次探测正常执行
    expect(await second).toBe(false);
    expect(checker).toHaveBeenCalledTimes(1);
    expect(checker).toHaveBeenCalledWith('code', 'B');
  });

  it('cancelAll 清理在途探测', async () => {
    const checker = vi.fn().mockResolvedValue(false);
    const d = new DebouncedUniqueChecker(checker, 20);
    const p = d.check('code', 'A');
    d.cancelAll();
    expect(await p).toBe(true);
    expect(checker).not.toHaveBeenCalled();
  });

  it('探测抛错按可用处理（resolve true）', async () => {
    const d = new DebouncedUniqueChecker(() => Promise.reject(new Error('网络错误')), 5);
    expect(await d.check('code', 'A')).toBe(true);
  });
});
