/**
 * ER 建模器单测（10FE §4 硬性要求）：
 * - 三档 confirmMode 交互流；confirmToken 不复用；DELETE_FIELD 永远 ≥CHECKBOX
 * - 409 冲突 → conflict 态（serverVersion 提取）
 * - 422 CONFIRM_TOKEN_INVALID → retryable 态
 * - MODIFY patch 白名单裁剪（fieldKey/type 不可改防线）
 * - 布局坐标不入 Schema 快照（LayoutDraft 独立于模型协议）
 * - 回滚 NOOP 前置判定
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// node 环境无 localStorage——最小桩（草稿测试只依赖 get/set/clear 语义）
class LocalStorageStub {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  clear(): void { this.map.clear(); }
}
vi.stubGlobal('localStorage', new LocalStorageStub());
import {
  buildAddField, buildDraftChanges, buildPatch, effectiveConfirmMode, extractRelationEdges,
  gridLayout, isDuplicateFieldKey, isRollbackNoop, loadLayoutDraft, onSaveError, onPrechecked,
  saveLayoutDraft, type ChangeOp, type PrecheckResp,
} from '../src/protocol';
import { runTwoPhaseRollback, runTwoPhaseSave, type SaveTransport } from '../src/save-flow';

const PRE: PrecheckResp = { risks: [], maxSeverity: 'INFO', confirmMode: 'INFO', confirmToken: 'tok-1' };

describe('effectiveConfirmMode（10FE §1.3 删除二次防线）', () => {
  it('无删除：透传后端档位', () => {
    expect(effectiveConfirmMode(PRE, [{ op: 'ADD_FIELD', fieldKey: 'a', field: {} }])).toBe('INFO');
  });

  it('DELETE_FIELD 时 INFO 升档为 CHECKBOX（后端返回什么不重要）', () => {
    expect(effectiveConfirmMode(PRE, [{ op: 'DELETE_FIELD', fieldKey: 'a' }])).toBe('CHECKBOX');
  });

  it('DELETE_FIELD 时 TYPE_MODEL_NAME 保持最高档', () => {
    const pre = { ...PRE, confirmMode: 'TYPE_MODEL_NAME' as const };
    expect(effectiveConfirmMode(pre, [{ op: 'DELETE_FIELD', fieldKey: 'a' }])).toBe('TYPE_MODEL_NAME');
  });

  it('非删除的 CHECKBOX 透传不升档', () => {
    const pre = { ...PRE, confirmMode: 'CHECKBOX' as const };
    expect(effectiveConfirmMode(pre, [{ op: 'MODIFY_FIELD', fieldKey: 'a', patch: { required: true } }])).toBe('CHECKBOX');
  });
});

describe('buildPatch 白名单（fieldKey/fieldType 冻结防线）', () => {
  it('白名单内键保留，fieldKey/type 篡改键被裁剪', () => {
    const patch = buildPatch({
      label: '新标签', required: true,
      fieldKey: 'hacked_key', type: 'number', fieldType: 'number',
    });
    expect(patch).toEqual({ label: '新标签', required: true });
    expect(patch).not.toHaveProperty('fieldKey');
    expect(patch).not.toHaveProperty('type');
  });

  it('buildAddField 冻结 fieldKey 进 field', () => {
    const op = buildAddField('amount', { label: '金额', type: 'number' });
    expect(op.op).toBe('ADD_FIELD');
    expect(op.field.fieldKey).toBe('amount');
  });
});

describe('两段式保存状态机（token 一次性铁律）', () => {
  function transport(overrides: Partial<SaveTransport> = {}): SaveTransport {
    return {
      precheck: vi.fn().mockResolvedValue(PRE),
      saveSchema: vi.fn().mockResolvedValue({ version: 8 }),
      ...overrides,
    };
  }

  it('INFO 档：一键确认成功保存，confirmValue 不发送', async () => {
    const t = transport();
    const result = await runTwoPhaseSave(t, '1', [{ op: 'ADD_FIELD', fieldKey: 'a', field: {} }], 7,
      async () => 'confirmed');
    expect(result.savedVersion).toBe(8);
    expect(result.phase.phase).toBe('idle');
    const body = (t.saveSchema as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(body.confirmToken).toBe('tok-1');
    expect(body.confirmValue).toBeUndefined();
  });

  it('TYPE_MODEL_NAME 档：confirmValue 必传', async () => {
    const t = transport({ precheck: vi.fn().mockResolvedValue({ ...PRE, confirmMode: 'TYPE_MODEL_NAME' }) });
    await runTwoPhaseSave(t, '1', [{ op: 'DELETE_FIELD', fieldKey: 'a' }], 7,
      async () => '订单管理');
    const body = (t.saveSchema as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(body.confirmValue).toBe('订单管理');
  });

  it('用户放弃：不调 saveSchema，token 不消费（自然过期）', async () => {
    const t = transport();
    const result = await runTwoPhaseSave(t, '1', [], 7, async () => null);
    expect(t.saveSchema).not.toHaveBeenCalled();
    expect(result.phase.phase).toBe('idle');
    expect(result.savedVersion).toBeUndefined();
  });

  it('保存失败（409）：token 作废进 conflict 态，重试须重新 precheck', async () => {
    const t = transport({
      saveSchema: vi.fn().mockRejectedValue({ status: 409, code: 'MODEL_VERSION_CONFLICT', details: { serverVersion: 9 } }),
    });
    const result = await runTwoPhaseSave(t, '1', [], 7, async () => 'ok');
    expect(result.phase).toEqual({ phase: 'conflict', serverVersion: 9 });
    // 重跑即重新 precheck（新 token）
    await runTwoPhaseSave(t, '1', [], 9, async () => 'ok');
    expect(t.precheck).toHaveBeenCalledTimes(2);
  });

  it('保存失败（422 CONFIRM_TOKEN_INVALID）：进 retryable 态', async () => {
    const t = transport({
      saveSchema: vi.fn().mockRejectedValue({ status: 422, code: 'CONFIRM_TOKEN_INVALID' }),
    });
    const result = await runTwoPhaseSave(t, '1', [], 7, async () => 'ok');
    expect(result.phase.phase).toBe('retryable');
  });

  it('precheck 后变更集篡改会导致 token 绑定失配——前端按新 changes 重新 precheck', async () => {
    const t = transport();
    const changes: ChangeOp[] = [{ op: 'ADD_FIELD', fieldKey: 'a', field: {} }];
    const first = await runTwoPhaseSave(t, '1', changes, 7, async () => 'ok');
    expect(first.savedVersion).toBe(8);
    // 第二轮同 changes 但不同内容：precheck 必被再次调用（每轮独立 token）
    await runTwoPhaseSave(t, '1', [{ ...changes[0], fieldKey: 'b' }], 8, async () => 'ok');
    expect(t.precheck).toHaveBeenCalledTimes(2);
    expect((t.precheck as ReturnType<typeof vi.fn>).mock.calls[1][1][0].fieldKey).toBe('b');
  });
});

describe('onPrechecked / onSaveError 状态构造', () => {
  it('onPrechecked 携带 effectiveMode（删除升档生效）', () => {
    const phase = onPrechecked(PRE, [{ op: 'DELETE_FIELD', fieldKey: 'x' }]);
    expect(phase).toEqual({ phase: 'confirm', precheck: PRE, effectiveMode: 'CHECKBOX' });
  });

  it('409 无 serverVersion 细节 → 降级 retryable', () => {
    expect(onSaveError(409, { code: 'MODEL_VERSION_CONFLICT' })).toEqual({
      phase: 'retryable', reason: 'MODEL_VERSION_CONFLICT',
    });
  });
});

describe('回滚两段式（01BE §A.3）', () => {
  it('confirmValue 必传（回滚统一 TYPE_MODEL_NAME）', async () => {
    const t = {
      rollbackPrecheck: vi.fn().mockResolvedValue({ ...PRE, confirmMode: 'TYPE_MODEL_NAME' }),
      rollback: vi.fn().mockResolvedValue({ version: 10 }),
    };
    const result = await runTwoPhaseRollback(t, '1', 5, async () => '订单管理');
    expect(result.savedVersion).toBe(10);
    const body = t.rollback.mock.calls[0][1];
    expect(body.targetVersion).toBe(5);
    expect(body.confirmValue).toBe('订单管理');
  });

  it('isRollbackNoop：当前版本即目标返回 true', () => {
    expect(isRollbackNoop(5, 5)).toBe(true);
    expect(isRollbackNoop(7, 5)).toBe(false);
  });
});

describe('布局坐标草稿（视图态不入 Schema）', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  it('草稿按租户+应用隔离存取；LayoutDraft 结构只含坐标', () => {
    saveLayoutDraft(1, 1, { positions: { '3': { x: 10, y: 20 } } });
    const draft = loadLayoutDraft(1, 1);
    expect(draft.positions['3']).toEqual({ x: 10, y: 20 });
    // 隔离：另一应用读取不到
    expect(loadLayoutDraft(1, 2).positions['3']).toBeUndefined();
    // 协议铁律：草稿对象不含任何 Schema 字段（仅 positions 键）
    expect(Object.keys(draft)).toEqual(['positions']);
  });

  it('损坏草稿静默重建为空 positions', () => {
    localStorage.setItem('schema_er_layout_1_1', '{{{broken');
    expect(loadLayoutDraft(1, 1)).toEqual({ positions: {} });
  });

  it('gridLayout：坐标不含模型业务字段（modelKey/name 不进输出值）', () => {
    const positions = gridLayout([{ id: '1', modelKey: 'orders', name: '订单', icon: null, status: 'ACTIVE', currentVersion: 1 }]);
    expect(positions['1']).toEqual({ x: 40, y: 40 });
    expect(JSON.stringify(positions)).not.toContain('orders');
  });
});

describe('关系边提取（画布连线协议）', () => {
  it('relation 字段生成边；DELETED 与非 relation 字段跳过', () => {
    const edges = extractRelationEdges([
      {
        id: '1', fields: [
          { fieldKey: 'buyer', label: '买家', type: 'relation', fieldStatus: 'ACTIVE', required: false, uniqueFlag: false, indexed: false, promoteStatus: null, sortOrder: 1, relation: { targetModelId: '2', cardinality: '1:n', cascade: 'FORBID' } },
          { fieldKey: 'gone', label: '已删关系', type: 'relation', fieldStatus: 'DELETED', required: false, uniqueFlag: false, indexed: false, promoteStatus: null, sortOrder: 2, relation: { targetModelId: '2', cardinality: '1:1', cascade: 'FORBID' } },
          { fieldKey: 'amount', label: '金额', type: 'number', fieldStatus: 'ACTIVE', required: false, uniqueFlag: false, indexed: false, promoteStatus: null, sortOrder: 3 },
        ],
      },
    ]);
    expect(edges).toEqual([{
      id: '1:buyer->2', sourceModelId: '1', sourceFieldKey: 'buyer',
      targetModelId: '2', cardinality: '1:n',
    }]);
  });
});

describe('buildDraftChanges（草稿 diff 收口）', () => {
  const active = { fieldKey: 'amount', label: '金额', type: 'number', fieldStatus: 'ACTIVE', required: false, uniqueFlag: false, indexed: false, promoteStatus: null, sortOrder: 1 };

  it('本地新增又被标记删除 → 抵消（不发 DELETE_FIELD）', () => {
    const ops = buildDraftChanges([active], [
      active,
      { fieldKey: 'tmp_new', label: '临时', type: 'text', _deleted: true },
    ]);
    expect(ops).toEqual([]);   // tmp_new 无服务端记录——抵消后零变更
  });

  it('服务端 ACTIVE 字段标记删除 → DELETE_FIELD', () => {
    const ops = buildDraftChanges([active], [{ ...active, _deleted: true }]);
    expect(ops).toEqual([{ op: 'DELETE_FIELD', fieldKey: 'amount' }]);
  });

  it('服务端 DELETED 字段再次标记删除 → 无操作（幂等）', () => {
    const deletedServer = { ...active, fieldStatus: 'DELETED' as const };
    const ops = buildDraftChanges([deletedServer], [{ ...deletedServer, _deleted: true }]);
    expect(ops).toEqual([]);
  });

  it('复活（服务端 DELETED + 本地未删）→ ADD_FIELD', () => {
    const deletedServer = { ...active, fieldStatus: 'DELETED' as const };
    const ops = buildDraftChanges([deletedServer], [active]);
    expect(ops[0]?.op).toBe('ADD_FIELD');
  });

  it('字段配置差异进 patch（enumOptions/relation/computed 按 JSON 深比较）', () => {
    const ops = buildDraftChanges(
      [{ ...active, type: 'enum', enumOptions: [{ value: 'a', label: 'A', status: 'ACTIVE' }] }],
      [{ ...active, type: 'enum', enumOptions: [{ value: 'a', label: 'A2', status: 'ACTIVE' }] }],
    );
    expect(ops[0]?.op).toBe('MODIFY_FIELD');
    expect((ops[0] as { patch: Record<string, unknown> }).patch.enumOptions)
      .toEqual([{ value: 'a', label: 'A2', status: 'ACTIVE' }]);
  });
});

describe('isDuplicateFieldKey（本地重名前置阻断）', () => {
  it('命中已有标识（含软删历史）；新标识放行', () => {
    const existing = [{ fieldKey: 'amount' }, { fieldKey: 'gone' }];
    expect(isDuplicateFieldKey(existing, 'amount')).toBe(true);
    expect(isDuplicateFieldKey(existing, 'gone')).toBe(true);
    expect(isDuplicateFieldKey(existing, 'fresh')).toBe(false);
  });
});
