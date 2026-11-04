/**
 * M12 ER 建模器协议层（10FE §1；01BE §4.2/A.1-A.3 契约镜像）：
 * - ChangeOp 联合体构建（ADD_FIELD/MODIFY_FIELD/DELETE_FIELD/PROMOTE_COLUMN）
 * - precheck 响应（risks[]/maxSeverity/confirmMode/confirmToken）
 * - 两段式保存状态机（token 一次性消费铁律：失败即弃，重新 precheck）
 *
 * 零第三方依赖（不引 reactflow——画布交互由 designer 宿主实现，本包只承载
 * 可单测的协议构建/状态机/diff 纯逻辑；DOM 依赖仅 localStorage 布局草稿）。
 */

/** 01BE §4.2 ChangeOp 联合体（前端构建形态，与后端 parseChanges 对齐）。 */
export type ChangeOp =
  | { op: 'ADD_FIELD'; fieldKey: string; field: Record<string, unknown> }
  | { op: 'MODIFY_FIELD'; fieldKey: string; patch: Record<string, unknown> }
  | { op: 'DELETE_FIELD'; fieldKey: string }
  | { op: 'PROMOTE_COLUMN'; fieldKey: string };

/** MODIFY patch 白名单（01BE §4.2——fieldKey/fieldType 不可改是后端铁律，前端构建时排除）。 */
export const MODIFY_PATCH_WHITELIST = [
  'label', 'required', 'uniqueFlag', 'indexed', 'defaultValue',
  'validators', 'enumOptions', 'relation', 'computed', 'sortOrder',
] as const;

/** 01BE §A.2 precheck 响应。 */
export interface PrecheckResp {
  risks: Risk[];
  maxSeverity: Severity;
  confirmMode: ConfirmMode;
  confirmToken: string;
}

export interface Risk {
  type: string;            // PAGE_REF / FLOW_REF / SCRIPT_REF / API_CONSUMER / DATA_VOLUME
  refId?: number;
  refName?: string;
  keyName?: string;
  calls30d?: number;
  count?: number;
  severity: Severity;
}

export type Severity = 'HIGH' | 'MEDIUM' | 'INFO';
export type ConfirmMode = 'INFO' | 'CHECKBOX' | 'TYPE_MODEL_NAME';

/** 01BE §A.1 模型详情（fieldView 形态）。 */
export interface ModelField {
  fieldKey: string;
  label: string;
  type: string;
  fieldStatus: 'ACTIVE' | 'DELETED';
  required: boolean;
  uniqueFlag: boolean;
  indexed: boolean;
  promoteStatus: string | null;
  defaultValue?: unknown;
  validators?: unknown[];
  enumOptions?: { value: string; label: string; color?: string; status: string }[];
  relation?: { targetModelId: string; cardinality: string; cascade: string };
  computed?: { expr: { kind: 'expr'; source: string; dependsOn?: string[] }; dependsOn: string[]; persistMode: string };
  sortOrder: number;
}

export interface ModelDetail {
  id: string;
  modelKey: string;
  name: string;
  icon: string | null;
  status: string;
  currentVersion: number;
  fields: ModelField[];
}

export interface ModelSummary {
  id: string;
  modelKey: string;
  name: string;
  icon: string | null;
  status: string;
  currentVersion: number;
}

/** 01BE §A.3 版本时间线条目。 */
export interface VersionRow {
  version: number;
  diffSummary: { op: string; fieldKey: string }[];
  operator: string;
  createdAt: string | null;
  rollbackFrom?: number;
}

/**
 * 保存会话状态机（10FE §1.3 前端铁律落地）：
 * - confirmToken 一次性：任何保存失败（409/422/网络）即弃当前 token，回 idle 待重新 precheck
 * - DELETE_FIELD 前端强制升档：即使后端返回低档也按 CHECKBOX 交互（二次防线）
 */
export type SavePhase =
  | { phase: 'idle' }
  | { phase: 'prechecking' }
  | { phase: 'confirm'; precheck: PrecheckResp; effectiveMode: ConfirmMode }
  | { phase: 'saving' }
  | { phase: 'conflict'; serverVersion: number }   // 409 → 三方对比入口
  | { phase: 'retryable'; reason: string };        // 422 CONFIRM_TOKEN_INVALID → 回 precheck

/** 前端确认档位（删除类永远不低于 CHECKBOX——10FE §1.3）。 */
export function effectiveConfirmMode(precheck: PrecheckResp, changes: ChangeOp[]): ConfirmMode {
  const hasDelete = changes.some((c) => c.op === 'DELETE_FIELD');
  if (hasDelete && precheck.confirmMode === 'INFO') return 'CHECKBOX';
  return precheck.confirmMode;
}

/** MODIFY patch 构建器：按白名单裁剪，防 fieldKey/type 篡改类负样本。 */
export function buildPatch(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of MODIFY_PATCH_WHITELIST) {
    if (patch[key] !== undefined) out[key] = patch[key];
  }
  return out;
}

/** ADD_FIELD 字段构建器：fieldKey/type 为创建时冻结面，其余走配置。 */
export function buildAddField(fieldKey: string, field: Record<string, unknown>): ChangeOp {
  return { op: 'ADD_FIELD', fieldKey, field: { ...field, fieldKey } };
}

/** 布局坐标草稿（10FE §1.2：坐标是视图态不入 Schema——localStorage 按租户+应用隔离）。 */
export interface LayoutDraft {
  /** modelId → 画布坐标 */
  positions: Record<string, { x: number; y: number }>;
}

export function layoutDraftKey(tenantId: string | number, appId: string | number): string {
  return `schema_er_layout_${tenantId}_${appId}`;
}

export function loadLayoutDraft(tenantId: string | number, appId: string | number): LayoutDraft {
  try {
    const raw = localStorage.getItem(layoutDraftKey(tenantId, appId));
    if (raw) {
      const parsed = JSON.parse(raw) as LayoutDraft;
      if (parsed && typeof parsed.positions === 'object') return parsed;
    }
  } catch { /* 损坏草稿静默重建 */ }
  return { positions: {} };
}

export function saveLayoutDraft(tenantId: string | number, appId: string | number, draft: LayoutDraft): void {
  try {
    localStorage.setItem(layoutDraftKey(tenantId, appId), JSON.stringify(draft));
  } catch { /* 配额满静默放弃（视图态非业务数据） */ }
}

/** 自动布局（10FE §1.2 dagre 分层布局的零依赖简化：网格排布，关系交叉最少化留给手动拖拽）。 */
export function gridLayout(models: ModelSummary[], perRow = 3): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};
  models.forEach((m, i) => {
    positions[m.id] = { x: 40 + (i % perRow) * 340, y: 40 + Math.floor(i / perRow) * 260 };
  });
  return positions;
}

/** 关系边提取：模型字段含 relation 配置 → 画布连线（n:n 由中转节点承载，此处仅出 1:1/1:n 直连）。 */
export interface RelationEdge {
  id: string;
  sourceModelId: string;
  sourceFieldKey: string;
  targetModelId: string;
  cardinality: string;
}

export function extractRelationEdges(models: { id: string; fields: ModelField[] }[]): RelationEdge[] {
  const edges: RelationEdge[] = [];
  for (const model of models) {
    for (const f of model.fields) {
      if (f.fieldStatus !== 'ACTIVE' || f.type !== 'relation' || !f.relation) continue;
      edges.push({
        id: `${model.id}:${f.fieldKey}->${f.relation.targetModelId}`,
        sourceModelId: model.id,
        sourceFieldKey: f.fieldKey,
        targetModelId: f.relation.targetModelId,
        cardinality: f.relation.cardinality,
      });
    }
  }
  return edges;
}

/** 保存状态机：precheck 成功 → confirm（携带 effectiveMode）。 */
export function onPrechecked(precheck: PrecheckResp, changes: ChangeOp[]): SavePhase {
  return { phase: 'confirm', precheck, effectiveMode: effectiveConfirmMode(precheck, changes) };
}

/** 保存失败：token 一律作废（409 冲突进对比态；422/其他进可重试态）。 */
export function onSaveError(status: number, body: { code?: string; details?: { serverVersion?: number } } | null): SavePhase {
  if (status === 409) {
    const serverVersion = body?.details?.serverVersion;
    if (typeof serverVersion === 'number') return { phase: 'conflict', serverVersion };
  }
  if (body?.code === 'CONFIRM_TOKEN_INVALID') {
    return { phase: 'retryable', reason: '确认令牌无效或已过期，需重新预检' };
  }
  return { phase: 'retryable', reason: body?.code ?? `HTTP ${status}` };
}

/** 版本时间线回滚前置校验：当前版本即目标 → NOOP（后端同判，前端提前阻断省一次往返）。 */
export function isRollbackNoop(currentVersion: number, targetVersion: number): boolean {
  return currentVersion === targetVersion;
}

/**
 * 草稿 → 变更集 diff（ModelTab buildChanges 的纯逻辑下沉，可单测）：
 * - 本地新增又被标记删除 → 抵消（不发 DELETE_FIELD）
 * - 服务端已 DELETED 字段再删 → 无操作（幂等由后端收口）
 * - 复活（服务端 DELETED + 本地未删）→ ADD_FIELD
 */
export interface DraftFieldLike extends Partial<ModelField> {
  fieldKey: string;
  _deleted?: boolean;
}

export function buildDraftChanges(serverFields: ModelField[], draftFields: DraftFieldLike[]): ChangeOp[] {
  const ops: ChangeOp[] = [];
  const serverMap = new Map(serverFields.map((f) => [f.fieldKey, f]));
  for (const f of draftFields) {
    const server = serverMap.get(f.fieldKey);
    if (f._deleted) {
      if (server && server.fieldStatus !== 'DELETED') {
        ops.push({ op: 'DELETE_FIELD', fieldKey: f.fieldKey });
      }
      continue;
    }
    if (!server || server.fieldStatus === 'DELETED') {
      ops.push({
        op: 'ADD_FIELD', fieldKey: f.fieldKey,
        field: {
          label: f.label, type: f.type, required: f.required, uniqueFlag: f.uniqueFlag,
          indexed: f.indexed, sortOrder: f.sortOrder,
          ...(f.enumOptions ? { enumOptions: f.enumOptions } : {}),
          ...(f.relation ? { relation: f.relation } : {}),
          ...(f.computed ? { computed: f.computed } : {}),
        },
      });
      continue;
    }
    const patch: Record<string, unknown> = {};
    if (server.label !== f.label) patch.label = f.label;
    if (server.required !== f.required) patch.required = f.required;
    if (server.uniqueFlag !== f.uniqueFlag) patch.uniqueFlag = f.uniqueFlag;
    if (server.indexed !== f.indexed) patch.indexed = f.indexed;
    if (server.sortOrder !== f.sortOrder) patch.sortOrder = f.sortOrder;
    if (JSON.stringify(server.enumOptions ?? null) !== JSON.stringify(f.enumOptions ?? null)) patch.enumOptions = f.enumOptions ?? [];
    if (JSON.stringify(server.relation ?? null) !== JSON.stringify(f.relation ?? null)) patch.relation = f.relation;
    if (JSON.stringify(server.computed ?? null) !== JSON.stringify(f.computed ?? null)) patch.computed = f.computed;
    if (Object.keys(patch).length) ops.push({ op: 'MODIFY_FIELD', fieldKey: f.fieldKey, patch: buildPatch(patch) });
  }
  return ops;
}

/** 字段标识本地重名前置判定（服务端 FIELD_KEY_DUPLICATED 兜底）。 */
export function isDuplicateFieldKey(existing: { fieldKey: string }[], candidate: string): boolean {
  return existing.some((f) => f.fieldKey === candidate);
}
