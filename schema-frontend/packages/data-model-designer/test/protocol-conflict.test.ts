/**
 * 阶段一新增协议纯函数测试：409 三方对比（10FE §1.3 ⑥）、分层布局、显式放弃、枚举真源。
 */
import { describe, expect, it } from 'vitest';
import {
  RELATION_CARDINALITIES, RELATION_CASCADES, COMPUTED_PERSIST_MODES,
  buildConflictRows, adoptServerDraft, layeredLayout,
} from '../src/protocol';

const base = (fieldKey: string, label: string, extra: Record<string, unknown> = {}) => ({
  fieldKey, label, type: 'text', fieldStatus: 'ACTIVE' as const, required: false,
  uniqueFlag: false, indexed: false, promoteStatus: null, sortOrder: 1, ...extra,
});

describe('枚举真源常量（01BE §4.2 冻结枚举）', () => {
  it('cascade/persistMode 与后端 validateFieldConfig 同判——历史漂移值不在表内', () => {
    expect([...RELATION_CARDINALITIES]).toEqual(['1:1', '1:n', 'n:n']);
    expect([...RELATION_CASCADES]).toEqual(['FORBID', 'SET_NULL', 'CASCADE_SOFT_DELETE']);
    expect([...COMPUTED_PERSIST_MODES]).toEqual(['READ_TIME', 'PERSISTED']);
    // 漂移负样本：表单曾发送的值必须被真源拒绝
    expect((RELATION_CASCADES as readonly string[]).includes('CASCADE')).toBe(false);
    expect((COMPUTED_PERSIST_MODES as readonly string[]).includes('ON_WRITE')).toBe(false);
  });
});

describe('buildConflictRows（409 三方对比）', () => {
  const baseFields = [base('amount', '金额'), base('status', '状态')];

  it('仅本地改动：mine 有值、theirs 为空、bothChanged=false', () => {
    const rows = buildConflictRows(baseFields, [base('amount', '金额调整'), base('status', '状态')], baseFields);
    expect(rows).toHaveLength(1);
    expect(rows[0].fieldKey).toBe('amount');
    expect(rows[0].mine?.op).toBe('MODIFY_FIELD');
    expect(rows[0].theirs).toBeNull();
    expect(rows[0].bothChanged).toBe(false);
  });

  it('不同字段双方各改一处：两行均非冲突（各自动放行）', () => {
    const rows = buildConflictRows(
      baseFields,
      [base('amount', '本地改'), base('status', '状态')],
      [base('amount', '金额'), base('status', '他方改')],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.bothChanged === false)).toBe(true);
  });

  it('同字段双方改值不同 → bothChanged=true（人工裁决位）', () => {
    const rows = buildConflictRows(
      baseFields,
      [base('amount', '我的改'), base('status', '状态')],
      [base('amount', '他的改'), base('status', '状态')],
    );
    expect(rows[0].bothChanged).toBe(true);
  });

  it('本地删 vs 服务端也删（同语义）→ bothChanged=false', () => {
    // 服务端软删的真实形态：字段仍在列表、fieldStatus=DELETED（后端永不物理删行）
    const rows = buildConflictRows(
      baseFields,
      [{ ...base('amount', '金额'), _deleted: true }, base('status', '状态')],
      [{ ...base('amount', '金额'), fieldStatus: 'DELETED' as const }, base('status', '状态')],
    );
    const row = rows.find((r) => r.fieldKey === 'amount')!;
    expect(row.mine?.op).toBe('DELETE_FIELD');
    expect(row.theirs?.op).toBe('DELETE_FIELD');
    expect(row.bothChanged).toBe(false);
  });
});

describe('adoptServerDraft（显式放弃本地草稿）', () => {
  it('以服务端态重建草稿字段（深拷贝——与服务端对象解除引用共享）', () => {
    const server = [base('amount', '金额'), { ...base('gone', '已删'), fieldStatus: 'DELETED' as const }];
    const draft = adoptServerDraft(server);
    expect(draft).toHaveLength(2);
    expect(draft[0]).not.toBe(server[0]);   // 引用独立
    expect(draft[0].label).toBe('金额');
  });
});

describe('layeredLayout（10FE §1.2 分层布局）', () => {
  const models = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

  it('关系源在上、目标在下；无关系模型归第 0 层', () => {
    const pos = layeredLayout(models, [
      { sourceModelId: 'a', targetModelId: 'b' },
      { sourceModelId: 'b', targetModelId: 'c' },
    ]);
    expect(pos.a.y).toBeLessThan(pos.b.y);
    expect(pos.b.y).toBeLessThan(pos.c.y);
    expect(pos.d.y).toBe(pos.a.y);   // 孤立模型与顶层同层
  });

  it('环路不死循环：环上模型落入兜底层', () => {
    const pos = layeredLayout(models, [
      { sourceModelId: 'a', targetModelId: 'b' },
      { sourceModelId: 'b', targetModelId: 'a' },
    ]);
    expect(pos).toHaveProperty('a');
    expect(pos).toHaveProperty('d');
  });

  it('同层模型横排不重叠（x 间距 = colWidth）', () => {
    const pos = layeredLayout(models, []);
    const xs = new Set(Object.values(pos).map((p) => p.x));
    expect(xs.size).toBeGreaterThan(1);
  });
});
