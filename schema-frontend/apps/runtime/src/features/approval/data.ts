/**
 * 审批中心数据层（spec 022 T3）。
 *
 * 把后端 021 的三种响应转成 UI 直接消费的形态：
 * - 待办列表 `/api/my/tasks` → TaskItem[]
 * - 已办列表 `/api/my/tasks/done` → DoneItem[]
 * - 实例详情 `/api/flow-instances/{id}` → InstanceDetail
 *
 * 纯函数（零 React）——转换逻辑可单测，组件只负责呈现。
 */

/** 待办项（/api/my/tasks 的 list 元素）。 */
export interface TaskItem {
  taskId: string;
  instanceId: string;
  nodeId: string;
  nodeName: string;
  /** ISO 时间串（后端 OffsetDateTime 序列化）。 */
  createdAt: string;
}

/** 已办项（/api/my/tasks/done 的 list 元素）。 */
export interface DoneItem {
  taskId: string;
  instanceId: string;
  nodeId: string;
  /** COMPLETE / REJECT（AUTO 已被后端排除）。 */
  action: string;
  comment: string | null;
  operatedAt: string;
  modelId: number | string | null;
  recordId: number | string | null;
  flowDefId: number | string | null;
  startedBy: number | string | null;
  /** 实例状态：RUNNING / FINISHED / SUSPENDED */
  status: string | null;
}

/** 引擎历史轨迹（实例详情的 history 元素）。 */
export interface HistoryEntry {
  activityId: string;
  activityName: string | null;
  /** startEvent / userTask / sequenceFlow / endEvent */
  activityType: string;
  assignee: number | string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** 实例详情（/api/flow-instances/{id}）。 */
export interface InstanceDetail {
  instanceId: string;
  modelId: number | string;
  recordId: number | string;
  /** 流程定义 id（T3 加：审批中心据此拉 schema 渲染画布）。 */
  flowDefId: number | string | null;
  status: string;
  startedBy: number | string;
  startedAt: string;
  /** flow_task_log 投影（办理过才有内容）。 */
  tasks: TaskLogEntry[];
  /** 引擎侧节点轨迹。 */
  history: HistoryEntry[];
}

/** 审计日志项（实例详情 tasks 的元素）。 */
export interface TaskLogEntry {
  task_id: string;
  node_id: string;
  action: string;
  operator_id: number | string;
  comment: string | null;
  operated_at: string;
}

// ---------- 解析（后端字段名/类型不完全统一，做一次收口） ----------

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown, fallback = ''): string {
  if (v == null) return fallback;
  return String(v);
}

/** 解析待办响应。 */
export function parseTasks(raw: unknown): TaskItem[] {
  const o = raw as { list?: unknown } | null;
  return asArray(o?.list).map((x) => {
    const r = x as Record<string, unknown>;
    return {
      taskId: str(r.taskId),
      instanceId: str(r.instanceId),
      nodeId: str(r.nodeId),
      nodeName: str(r.nodeName),
      createdAt: str(r.createdAt),
    };
  }).filter((t) => t.taskId !== '');
}

/** 解析已办响应（含 total）。 */
export function parseDone(raw: unknown): { list: DoneItem[]; total: number } {
  const o = raw as { list?: unknown; total?: unknown } | null;
  const list = asArray(o?.list).map((x) => {
    const r = x as Record<string, unknown>;
    return {
      taskId: str(r.task_id ?? r.taskId),
      instanceId: str(r.instance_id ?? r.instanceId),
      nodeId: str(r.node_id ?? r.nodeId),
      action: str(r.action),
      comment: r.comment == null ? null : String(r.comment),
      operatedAt: str(r.operated_at ?? r.operatedAt),
      modelId: (r.model_id ?? r.modelId ?? null) as DoneItem['modelId'],
      recordId: (r.record_id ?? r.recordId ?? null) as DoneItem['recordId'],
      flowDefId: (r.flow_def_id ?? r.flowDefId ?? null) as DoneItem['flowDefId'],
      startedBy: (r.started_by ?? r.startedBy ?? null) as DoneItem['startedBy'],
      status: r.status == null ? null : String(r.status),
    };
  });
  const total = typeof o?.total === 'number' ? o.total : list.length;
  return { list, total };
}

/** 解析实例详情。 */
export function parseInstanceDetail(raw: unknown): InstanceDetail | null {
  const r = raw as Record<string, unknown> | null;
  if (r == null || r.instanceId == null) return null;
  return {
    instanceId: str(r.instanceId),
    modelId: (r.modelId ?? '') as InstanceDetail['modelId'],
    recordId: (r.recordId ?? '') as InstanceDetail['recordId'],
    flowDefId: (r.flowDefId ?? r.flow_def_id ?? null) as InstanceDetail['flowDefId'],
    status: str(r.status),
    startedBy: (r.startedBy ?? '') as InstanceDetail['startedBy'],
    startedAt: str(r.startedAt),
    tasks: asArray(r.tasks).map((x) => {
      const t = x as Record<string, unknown>;
      return {
        task_id: str(t.task_id),
        node_id: str(t.node_id),
        action: str(t.action),
        operator_id: (t.operator_id ?? '') as TaskLogEntry['operator_id'],
        comment: t.comment == null ? null : String(t.comment),
        operated_at: str(t.operated_at),
      };
    }),
    history: asArray(r.history).map((x) => {
      const h = x as Record<string, unknown>;
      return {
        activityId: str(h.activityId),
        activityName: h.activityName == null ? null : String(h.activityName),
        activityType: str(h.activityType),
        assignee: (h.assignee ?? null) as HistoryEntry['assignee'],
        startedAt: h.startedAt == null ? null : String(h.startedAt),
        endedAt: h.endedAt == null ? null : String(h.endedAt),
      };
    }),
  };
}

// ---------- 派生：节点状态着色（喂给 FlowCanvas 的 instanceState） ----------

/**
 * 把 instance detail 的 history 折算成「每节点状态」。
 *
 * 规则（与 FlowCanvas 的封闭四态对齐）：
 * - 有 endedAt → DONE
 * - 无 endedAt 且是 userTask 且实例 RUNNING → ACTIVE
 * - 其余（未出现在 history 里）→ 不返回（不着色 = PENDING 语义）
 *
 * ⚠️ history 里包含 sequenceFlow（边的轨迹），必须过滤——它们不是节点。
 */
export function toNodeStates(detail: InstanceDetail): { nodeId: string; state: string }[] {
  const NODE_TYPES = new Set(['startEvent', 'userTask', 'endEvent', 'exclusiveGateway',
    'parallelGateway', 'inclusiveGateway', 'serviceTask']);
  const byNode = new Map<string, string>();

  for (const h of detail.history) {
    if (!NODE_TYPES.has(h.activityType)) continue;     // 跳过 sequenceFlow
    const done = h.endedAt != null;
    if (done) {
      byNode.set(h.activityId, 'DONE');
    } else if (!byNode.has(h.activityId)) {
      // 未结束：实例在跑 → ACTIVE；实例已结束但节点未结束属异常，标 ACTIVE 供排查
      byNode.set(h.activityId, 'ACTIVE');
    }
  }

  // 实例已结束时，仍未 DONE 的节点视为 SKIPPED（未走到的分支）
  if (detail.status === 'FINISHED' || detail.status === 'TERMINATED') {
    for (const [k, v] of byNode) {
      if (v === 'ACTIVE') byNode.set(k, 'SKIPPED');
    }
  }

  return [...byNode].map(([nodeId, state]) => ({ nodeId, state }));
}

/**
 * 把 history 转成时间线条目（UI 直接渲染）。
 *
 * 只保留**节点**轨迹（过滤 sequenceFlow）——连线的耗时对使用者无意义，
 * 混在时间线里会淹没真正的审批步骤。
 */
export interface TimelineEntry {
  activityId: string;
  label: string;
  type: string;
  state: 'DONE' | 'ACTIVE';
  startedAt: string | null;
  endedAt: string | null;
  durationText: string;
}

export function toTimeline(detail: InstanceDetail): TimelineEntry[] {
  const NODE_TYPES = new Set(['startEvent', 'userTask', 'endEvent', 'exclusiveGateway',
    'parallelGateway', 'inclusiveGateway', 'serviceTask']);
  return detail.history
    .filter((h) => NODE_TYPES.has(h.activityType))
    .map((h) => ({
      activityId: h.activityId,
      label: h.activityName || typeLabel(h.activityType),
      type: h.activityType,
      state: h.endedAt != null ? 'DONE' as const : 'ACTIVE' as const,
      startedAt: h.startedAt,
      endedAt: h.endedAt,
      durationText: durationOf(h.startedAt, h.endedAt),
    }));
}

/** 节点类型中文名（时间线兜底展示）。 */
export function typeLabel(t: string): string {
  const m: Record<string, string> = {
    startEvent: '开始',
    endEvent: '结束',
    userTask: '审批',
    serviceTask: '服务任务',
    exclusiveGateway: '条件分支',
    parallelGateway: '并行网关',
    inclusiveGateway: '包容网关',
  };
  return m[t] ?? t;
}

/** 计算耗时文本（秒/分钟/小时）。 */
export function durationOf(start: string | null, end: string | null): string {
  if (start == null || end == null) return '';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.round(h / 24)} 天`;
}

/** 实例状态中文名。 */
export function instanceStatusText(s: string): string {
  const m: Record<string, string> = {
    RUNNING: '进行中',
    FINISHED: '已办结',
    SUSPENDED: '已挂起',
    TERMINATED: '已终止',
  };
  return m[s] ?? s;
}

/** 动作中文名。 */
export function actionText(a: string): string {
  const m: Record<string, string> = {
    COMPLETE: '同意',
    REJECT: '驳回',
    AUTO: '系统挂起',
  };
  return m[a] ?? a;
}

/**
 * 办理错误的用户可读文案（A7 错误矩阵的前端侧）。
 *
 * 后端错误码 → 中文提示；未知码保留原文便于排查。
 */
export function completeErrorText(code: string, fallback: string): string {
  const m: Record<string, string> = {
    TASK_NOT_ASSIGNED: '该任务未指派给你，无法办理',
    TASK_ALREADY_COMPLETED: '该任务已被处理，请刷新列表',
    TASK_NOT_FOUND: '任务不存在或已被撤销，请刷新列表',
    COMMENT_REQUIRED: '驳回必须填写审批意见',
    FLOW_DEF_NOT_PUBLISHED: '流程引擎未启用，无法办理',
    UNAUTHORIZED: '登录已过期，请重新登录',
  };
  return m[code] ?? fallback;
}