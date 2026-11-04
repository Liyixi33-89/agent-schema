/**
 * 两段式保存编排器（10FE §1.3；01BE §4.2）：
 * 传输层由宿主注入（designer 的 ApiClient）——本包零 fetch 依赖，纯可测编排。
 * 铁律：confirmToken 一次性消费——保存失败后本会话 token 立即作废，必须重新 precheck。
 */
import type { ChangeOp, PrecheckResp, SavePhase } from './protocol';
import { onSaveError, onPrechecked } from './protocol';

/** 传输端口（宿主注入：真实 HTTP / 测试注入桩）。 */
export interface SaveTransport {
  precheck(modelId: string, changes: ChangeOp[]): Promise<PrecheckResp>;
  saveSchema(modelId: string, body: {
    changes: ChangeOp[]; baseVersion: number; confirmToken: string; confirmValue?: string;
  }): Promise<{ version: number }>;
}

export interface SaveResult {
  phase: SavePhase;
  savedVersion?: number;
}

/** 单次两段式保存流程：precheck → confirm 回调（宿主渲染确认弹层并收集 confirmValue）→ saveSchema。 */
export async function runTwoPhaseSave(
  transport: SaveTransport,
  modelId: string,
  changes: ChangeOp[],
  baseVersion: number,
  /** 确认交互：接收 precheck 结果，返回 confirmValue（TYPE_MODEL_NAME 必填）或 null 表示放弃。 */
  confirm: (precheck: PrecheckResp, effectiveMode: string) => Promise<string | null>,
): Promise<SaveResult> {
  const precheck = await transport.precheck(modelId, changes);
  const phase = onPrechecked(precheck, changes);
  const { effectiveMode } = phase as Extract<SavePhase, { phase: 'confirm' }>;

  const confirmValue = await confirm(precheck, effectiveMode);
  if (confirmValue == null) return { phase: { phase: 'idle' } };   // 用户放弃：token 自然过期

  try {
    const body: { changes: ChangeOp[]; baseVersion: number; confirmToken: string; confirmValue?: string } = {
      changes, baseVersion, confirmToken: precheck.confirmToken,
    };
    if (effectiveMode === 'TYPE_MODEL_NAME') body.confirmValue = confirmValue;
    const saved = await transport.saveSchema(modelId, body);
    return { phase: { phase: 'idle' }, savedVersion: saved.version };
  } catch (e) {
    const err = e as { status?: number; code?: string; details?: { serverVersion?: number } };
    return {
      phase: onSaveError(
        err.status ?? 0,
        { code: err.code, details: err.details } as { code?: string; details?: { serverVersion?: number } } | null,
      ),
    };
  }
}

/** 回滚两段式（01BE §A.3：独立 precheck，token 绑定 targetVersion）。 */
export interface RollbackTransport {
  rollbackPrecheck(modelId: string, targetVersion: number): Promise<PrecheckResp>;
  rollback(modelId: string, body: { targetVersion: number; confirmToken: string; confirmValue?: string }): Promise<{ version: number }>;
}

export async function runTwoPhaseRollback(
  transport: RollbackTransport,
  modelId: string,
  targetVersion: number,
  confirm: (precheck: PrecheckResp) => Promise<string | null>,
): Promise<SaveResult> {
  const precheck = await transport.rollbackPrecheck(modelId, targetVersion);
  const confirmValue = await confirm(precheck);
  if (confirmValue == null) return { phase: { phase: 'idle' } };
  try {
    const saved = await transport.rollback(modelId, {
      targetVersion, confirmToken: precheck.confirmToken, confirmValue,
    });
    return { phase: { phase: 'idle' }, savedVersion: saved.version };
  } catch (e) {
    const err = e as { status?: number; code?: string; details?: { serverVersion?: number } };
    return {
      phase: onSaveError(
        err.status ?? 0,
        { code: err.code, details: err.details } as { code?: string; details?: { serverVersion?: number } } | null,
      ),
    };
  }
}
