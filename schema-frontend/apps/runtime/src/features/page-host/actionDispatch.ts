/**
 * 表单动作分发（spec 022 T4）：提交成功后的 TRIGGER_FLOW 消费。
 *
 * ## 为什么单独一层
 * 动作分发要判断「该不该触发、用哪个记录、失败怎么提示」——这些是纯决策，
 * 与 React/请求无关。把它们抽成纯函数后：错误矩阵可单测穷举，
 * 组件只负责串联（提交 → 分发 → 呈现结果）。
 *
 * ## 语义（协议 ACTION_TYPES）
 * ```ts
 * { type: 'TRIGGER_FLOW'; flowId: string; bizKeyFrom: string }
 * ```
 * - `flowId`：流程定义 id
 * - `bizKeyFrom`：业务记录 id 的来源字段名；空串/缺省表示「用本次提交的记录 id」
 */

/** TRIGGER_FLOW 动作（协议子集——只取分发需要的字段）。 */
export interface TriggerFlowAction {
  type: 'TRIGGER_FLOW';
  /** 流程定义 id（数字串或数字）。 */
  flowId: string | number;
  /**
   * 业务记录 id 来源：
   * - `''` / 缺省 → 用本次提交产生的记录 id（新建场景的默认语义）
   * - 其他 → 从提交数据里取该字段的值（如引用外部业务记录）
   */
  bizKeyFrom?: string;
}

/** 页面动作的宽松形态（PageSchema.actions 元素）。 */
export interface AnyAction {
  type: string;
  [k: string]: unknown;
}

/** 从页面动作清单里挑出全部 TRIGGER_FLOW。 */
export function pickTriggerFlowActions(actions: AnyAction[] | undefined | null): TriggerFlowAction[] {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((a) => a?.type === 'TRIGGER_FLOW' && a.flowId != null && `${a.flowId}` !== '')
    .map((a) => ({
      type: 'TRIGGER_FLOW' as const,
      flowId: a.flowId as string | number,
      ...(typeof a.bizKeyFrom === 'string' ? { bizKeyFrom: a.bizKeyFrom } : {}),
    }));
}

/** 分发上下文：提交结果 + 记录定位信息。 */
export interface DispatchContext {
  /** 页面绑定的模型 id（发起流程要 modelId + recordId 定位记录）。 */
  modelId: string | number | undefined;
  /** 当前编辑的记录 id（编辑态已知；新建态为 undefined）。 */
  recordId?: string | number;
  /** 服务端提交响应（新建时 `{id}`）。 */
  serverResponse?: unknown;
  /** 提交的业务数据（供 bizKeyFrom 取值）。 */
  submittedData?: Record<string, unknown>;
}

/**
 * 解析本次要发起的业务记录 id。
 *
 * 优先级：bizKeyFrom 指定字段 > 编辑态 recordId > 新建响应 id。
 * 返回 null 表示无法定位（调用方应给「流程未发起」的明确提示，而非静默跳过）。
 */
export function resolveRecordId(
  action: TriggerFlowAction,
  ctx: DispatchContext,
): string | null {
  const from = action.bizKeyFrom;
  if (from != null && from !== '') {
    const v = ctx.submittedData?.[from];
    if (v == null || `${v}` === '') return null;
    return String(v);
  }
  if (ctx.recordId != null && `${ctx.recordId}` !== '') return String(ctx.recordId);
  const resp = ctx.serverResponse as { id?: unknown } | null | undefined;
  if (resp?.id != null && `${resp.id}` !== '') return String(resp.id);
  return null;
}

/** 单个动作的分发计划（可执行或明确不可执行及原因）。 */
export type DispatchPlan =
  | { kind: 'trigger'; flowId: string; modelId: string; recordId: string }
  | { kind: 'skip'; reason: 'NO_MODEL' | 'NO_RECORD'; message: string };

/**
 * 把动作 + 上下文折算成可执行计划。
 *
 * 纯函数——不发请求。宿主拿到 `trigger` 计划才真正调发起接口，
 * 拿到 `skip` 计划直接把 message 呈现给用户（不静默）。
 */
export function planTriggerFlow(action: TriggerFlowAction, ctx: DispatchContext): DispatchPlan {
  if (ctx.modelId == null || `${ctx.modelId}` === '') {
    return {
      kind: 'skip',
      reason: 'NO_MODEL',
      message: '流程未发起：页面未绑定数据模型',
    };
  }
  const recordId = resolveRecordId(action, ctx);
  if (recordId == null) {
    return {
      kind: 'skip',
      reason: 'NO_RECORD',
      message: '流程未发起：无法确定业务记录（保存后重试或检查 bizKeyFrom 配置）',
    };
  }
  return {
    kind: 'trigger',
    flowId: String(action.flowId),
    modelId: String(ctx.modelId),
    recordId,
  };
}

// ---------- 错误矩阵（A7） ----------

/** 单个动作的分发结果。 */
export interface DispatchOutcome {
  flowId: string;
  ok: boolean;
  /** 成功时的实例 id。 */
  instanceId?: string;
  /** 失败错误码（后端原文，便于排查）。 */
  code?: string;
  /** 失败的用户可读文案。 */
  message?: string;
}

/**
 * 发起流程失败的文案矩阵（A7）。
 *
 * 三个已知码给明确指引；未知码保留后端原文（不吞掉——排查要靠它）。
 * 未映射的情况不猜测语义，避免给出误导性的「操作建议」。
 */
export function triggerFlowErrorText(code: string, fallback: string): string {
  const m: Record<string, string> = {
    INSTANCE_ALREADY_RUNNING: '该记录已有进行中的流程，请到审批中心查看进度',
    FLOW_DEF_NOT_PUBLISHED: '流程未发布或流程引擎未启用，请联系管理员检查流程配置',
    RECORD_NOT_FOUND: '业务记录不存在，流程未发起',
    FORBIDDEN: '没有发起该流程的权限',
    UNAUTHORIZED: '登录已过期，请重新登录后重试',
  };
  return m[code] ?? fallback;
}

/**
 * 汇总多动作结果 → 页面提示。
 *
 * 返回 null 表示「全部成功且只有一个动作」——这种情况不打扰用户
 * （表单提交本身已有成功提示，再加一条「流程已发起」是噪音）。
 * 有失败、或成功多个，才需要明确告知。
 */
export function summarizeOutcomes(outcomes: DispatchOutcome[]): {
  type: 'success' | 'warning' | 'error';
  message: string;
} | null {
  if (outcomes.length === 0) return null;
  const failed = outcomes.filter((o) => !o.ok);
  const succeeded = outcomes.filter((o) => o.ok);

  if (failed.length === 0) {
    if (succeeded.length === 1) return null;   // 单动作成功：不额外提示
    return { type: 'success', message: `${succeeded.length} 个流程已发起` };
  }
  if (succeeded.length === 0) {
    return {
      type: 'error',
      message: failed.length === 1
        ? (failed[0].message ?? '流程发起失败')
        : `${failed.length} 个流程发起失败：${failed.map((f) => f.message).join('；')}`,
    };
  }
  return {
    type: 'warning',
    message: `${succeeded.length} 个流程已发起，${failed.length} 个失败：`
      + failed.map((f) => f.message).join('；'),
  };
}

/** 从发起接口响应里取实例 id（`{instanceId}`；兼容 `{instance_id}`）。 */
export function parseStartResponse(raw: unknown): string | null {
  const o = raw as { instanceId?: unknown; instance_id?: unknown } | null;
  const v = o?.instanceId ?? o?.instance_id;
  return v == null || `${v}` === '' ? null : String(v);
}

/** 从错误对象提取 code/message（ServerError 形态；普通 Error 取 message）。 */
export function parseError(e: unknown): { code: string; message: string } {
  if (e != null && typeof e === 'object') {
    const o = e as { code?: unknown; message?: unknown };
    if (typeof o.code === 'string') {
      return { code: o.code, message: typeof o.message === 'string' ? o.message : o.code };
    }
    if (typeof o.message === 'string') return { code: '', message: o.message };
  }
  return { code: '', message: String(e) };
}