/**
 * 动作分发纯函数测试（spec 022 T4 / A7）。
 *
 * 重点覆盖 A7 错误矩阵与「无绑定表单零行为」的两条前提：
 * 1. 没有 TRIGGER_FLOW 动作 → 分发计划为空（宿主零额外请求）
 * 2. 记录了流程但无法定位记录 → 明确 skip（不静默）
 */
import { describe, expect, it } from 'vitest';
import {
  parseError, parseStartResponse, pickTriggerFlowActions, planTriggerFlow,
  resolveRecordId, summarizeOutcomes, triggerFlowErrorText,
  type DispatchOutcome, type TriggerFlowAction,
} from './actionDispatch';

describe('pickTriggerFlowActions', () => {
  it('挑出 TRIGGER_FLOW 并保留 flowId/bizKeyFrom', () => {
    const got = pickTriggerFlowActions([
      { type: 'SUBMIT', successBehavior: 'TOAST' },
      { type: 'TRIGGER_FLOW', flowId: '24', bizKeyFrom: '' },
      { type: 'CALL_API', url: '/x' },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: 'TRIGGER_FLOW', flowId: '24' });
  });

  it('🔴 无 TRIGGER_FLOW 时返回空数组（A7 零行为回归前提）', () => {
    expect(pickTriggerFlowActions([{ type: 'SUBMIT', successBehavior: 'TOAST' }])).toEqual([]);
    expect(pickTriggerFlowActions([])).toEqual([]);
    expect(pickTriggerFlowActions(undefined)).toEqual([]);
    expect(pickTriggerFlowActions(null)).toEqual([]);
  });

  it('flowId 缺失/空串的动作被过滤（配置不完整不能触发）', () => {
    const got = pickTriggerFlowActions([
      { type: 'TRIGGER_FLOW', flowId: '' },
      { type: 'TRIGGER_FLOW' },
      { type: 'TRIGGER_FLOW', flowId: '7' },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].flowId).toBe('7');
  });

  it('多个 TRIGGER_FLOW 全部保留', () => {
    const got = pickTriggerFlowActions([
      { type: 'TRIGGER_FLOW', flowId: '1' },
      { type: 'TRIGGER_FLOW', flowId: '2' },
    ]);
    expect(got.map((a) => a.flowId)).toEqual(['1', '2']);
  });
});

describe('resolveRecordId', () => {
  const action = (bizKeyFrom?: string): TriggerFlowAction =>
    ({ type: 'TRIGGER_FLOW', flowId: '1', ...(bizKeyFrom !== undefined ? { bizKeyFrom } : {}) });

  it('新建：取服务端响应的 id', () => {
    expect(resolveRecordId(action(''), { modelId: 1, serverResponse: { id: '99901' } })).toBe('99901');
  });

  it('编辑：优先用已知 recordId', () => {
    expect(resolveRecordId(action(''), { modelId: 1, recordId: 555, serverResponse: { id: '99901' } }))
      .toBe('555');
  });

  it('bizKeyFrom 指定字段时优先取提交数据里的值', () => {
    expect(resolveRecordId(action('order_no'), {
      modelId: 1, recordId: 555, serverResponse: { id: '99901' },
      submittedData: { order_no: 'A-2026-001' },
    })).toBe('A-2026-001');
  });

  it('bizKeyFrom 字段为空 → null（不回落，避免发起到错误记录）', () => {
    expect(resolveRecordId(action('order_no'), {
      modelId: 1, recordId: 555, submittedData: { order_no: '' },
    })).toBeNull();
  });

  it('完全无处可取 → null', () => {
    expect(resolveRecordId(action(''), { modelId: 1 })).toBeNull();
    expect(resolveRecordId(action(''), { modelId: 1, serverResponse: {} })).toBeNull();
  });
});

describe('planTriggerFlow', () => {
  const act: TriggerFlowAction = { type: 'TRIGGER_FLOW', flowId: 24, bizKeyFrom: '' };

  it('正常 → trigger 计划（id 全部字符串化）', () => {
    const p = planTriggerFlow(act, { modelId: 1, serverResponse: { id: '99901' } });
    expect(p).toEqual({ kind: 'trigger', flowId: '24', modelId: '1', recordId: '99901' });
  });

  it('页面未绑定模型 → skip NO_MODEL', () => {
    const p = planTriggerFlow(act, { modelId: undefined, serverResponse: { id: '1' } });
    expect(p.kind).toBe('skip');
    expect(p).toMatchObject({ reason: 'NO_MODEL' });
    expect((p as { message: string }).message).toContain('未绑定数据模型');
  });

  it('拿不到记录 id → skip NO_RECORD（明确提示，不静默）', () => {
    const p = planTriggerFlow(act, { modelId: 1 });
    expect(p).toMatchObject({ kind: 'skip', reason: 'NO_RECORD' });
    expect((p as { message: string }).message).toContain('无法确定业务记录');
  });
});

describe('triggerFlowErrorText（A7 错误矩阵）', () => {
  it('INSTANCE_ALREADY_RUNNING → 指引去审批中心', () => {
    const t = triggerFlowErrorText('INSTANCE_ALREADY_RUNNING', 'x');
    expect(t).toContain('已有进行中的流程');
    expect(t).toContain('审批中心');
  });

  it('FLOW_DEF_NOT_PUBLISHED → 指引联系管理员', () => {
    const t = triggerFlowErrorText('FLOW_DEF_NOT_PUBLISHED', 'x');
    expect(t).toContain('流程未发布');
    expect(t).toContain('管理员');
  });

  it('RECORD_NOT_FOUND / FORBIDDEN / UNAUTHORIZED 均有专属文案', () => {
    expect(triggerFlowErrorText('RECORD_NOT_FOUND', 'x')).toContain('记录不存在');
    expect(triggerFlowErrorText('FORBIDDEN', 'x')).toContain('权限');
    expect(triggerFlowErrorText('UNAUTHORIZED', 'x')).toContain('登录');
  });

  it('未知码保留后端原文（不吞错误）', () => {
    expect(triggerFlowErrorText('SOMETHING_NEW', '后端原文')).toBe('后端原文');
  });
});

describe('summarizeOutcomes', () => {
  const ok = (id: string): DispatchOutcome => ({ flowId: '1', ok: true, instanceId: id });
  const bad = (msg: string): DispatchOutcome => ({ flowId: '1', ok: false, code: 'X', message: msg });

  it('无动作 → null（零提示）', () => {
    expect(summarizeOutcomes([])).toBeNull();
  });

  it('单动作成功 → null（不打扰，提交本身已有成功提示）', () => {
    expect(summarizeOutcomes([ok('i1')])).toBeNull();
  });

  it('多动作全成功 → success 汇总', () => {
    expect(summarizeOutcomes([ok('i1'), ok('i2')])).toEqual({
      type: 'success', message: '2 个流程已发起',
    });
  });

  it('单动作失败 → error 用其 message', () => {
    expect(summarizeOutcomes([bad('该记录已有进行中的流程，请到审批中心查看进度')])).toEqual({
      type: 'error', message: '该记录已有进行中的流程，请到审批中心查看进度',
    });
  });

  it('多动作全失败 → error 拼接', () => {
    const r = summarizeOutcomes([bad('失败A'), bad('失败B')])!;
    expect(r.type).toBe('error');
    expect(r.message).toContain('失败A');
    expect(r.message).toContain('失败B');
  });

  it('部分成功 → warning（既告知成功也不隐瞒失败）', () => {
    const r = summarizeOutcomes([ok('i1'), bad('失败B')])!;
    expect(r.type).toBe('warning');
    expect(r.message).toContain('1 个流程已发起');
    expect(r.message).toContain('失败B');
  });
});

describe('parseStartResponse / parseError', () => {
  it('取 instanceId（兼容 snake_case）', () => {
    expect(parseStartResponse({ instanceId: 'i-1' })).toBe('i-1');
    expect(parseStartResponse({ instance_id: 'i-2' })).toBe('i-2');
    expect(parseStartResponse({})).toBeNull();
    expect(parseStartResponse(null)).toBeNull();
  });

  it('parseError 优先取 code', () => {
    expect(parseError({ code: 'INSTANCE_ALREADY_RUNNING', message: 'msg' }))
      .toEqual({ code: 'INSTANCE_ALREADY_RUNNING', message: 'msg' });
    expect(parseError(new Error('boom'))).toEqual({ code: '', message: 'boom' });
    expect(parseError('plain')).toEqual({ code: '', message: 'plain' });
  });
});