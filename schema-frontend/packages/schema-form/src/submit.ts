/**
 * 提交协议（03FE §5 + 02FE §2 管线 ④ SUBMIT 动作链）：
 * 三阶段——前端全量校验 → 序列化（卸载字段剔除）→ 服务端提交。
 * 服务端校验对齐（03FE §7）：服务端 422 VALIDATION_FAILED 时字段级错误回填
 * （后端 WriteValidator 错误体 {code, message} —— 前端按 fieldKey 归位）。
 */
import type { FormStore } from './store';

export type SuccessBehavior = 'REFRESH' | 'REDIRECT' | 'TOAST';

export interface SubmitAction {
  type: 'SUBMIT';
  successBehavior: SuccessBehavior;
  redirectTo?: string;
  /** 跳过唯一性异步校验（暂存草稿模式——03FE §5）。 */
  draft?: boolean;
}

export interface SubmitResult {
  ok: boolean;
  /** 服务端字段级错误（fieldKey → 文案——回填字段下方）。 */
  fieldErrors: Record<string, string>;
  /** 服务端整单错误（不含字段位——顶部提示）。 */
  globalError?: string;
  /** 成功后的行为指令（宿主执行 REFRESH/REDIRECT/TOAST）。 */
  successBehavior?: SuccessBehavior;
  redirectTo?: string;
}

/** 提交执行器注入（宿主提供——schema-form 不直接发请求，DIP）。 */
export interface SubmitTransport {
  /** 提交载荷 → 服务端响应；失败抛 ServerError（结构化错误体）。 */
  submit(payload: Record<string, unknown>): Promise<unknown>;
}

export class ServerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ServerError';
  }
}

/** 提交管线（03FE §5 校验时机：提交时全量校验）。 */
export async function executeSubmit(
  store: FormStore,
  action: SubmitAction,
  transport: SubmitTransport,
): Promise<SubmitResult> {
  // ① 前端全量校验（含 requiredWhen 动态必填；卸载字段不参与）
  const firstError = store.validateAll();
  if (firstError) {
    return { ok: false, fieldErrors: { [firstError.fieldKey]: firstError.message } };
  }
  // ② 唯一性异步校验（提交态才跑——草稿跳过，03FE §5）
  if (!action.draft) {
    for (const [key] of store.fields) {
      const err = await store.validateUnique(key, store.get(key));
      if (err) return { ok: false, fieldErrors: { [key]: err } };
    }
  }
  // ③ 序列化提交（草稿全量 / 正常提交剔除卸载字段）
  const payload = action.draft ? store.serializeDraft() : store.serialize();
  try {
    await transport.submit(payload);
    return {
      ok: true,
      fieldErrors: {},
      successBehavior: action.successBehavior,
      redirectTo: action.redirectTo,
    };
  } catch (e) {
    if (e instanceof ServerError) {
      return { ok: false, fieldErrors: e.fieldErrors, globalError: e.message };
    }
    return { ok: false, fieldErrors: {}, globalError: e instanceof Error ? e.message : String(e) };
  }
}
