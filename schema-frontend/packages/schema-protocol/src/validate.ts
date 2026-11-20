import type { FieldSchema, FlowSchema, LayoutNode, ModelSchema, PageSchema } from './types';
import { APPROVER_RULE_MODES, FLOW_NODE_TYPES } from './types';

/** zod 未引入前的手写结构校验器——零运行时依赖门禁（AGENTS.md），结构定义与 types.ts 同源 */
export class SchemaValidationError extends Error {
  readonly pointers: string[];
  constructor(pointers: string[]) {
    super(`Schema validation failed: ${pointers.join('; ')}`);
    this.name = 'SchemaValidationError';
    this.pointers = pointers;
  }
}

const PROP_PATTERN = /^[A-Za-z][\w.]*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isPrimitive(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/** PropValue 判别：expr 标识 / 动作数组 / 节点数组 / 其余静态 JSON（01FE §2 判别规则） */
function checkPropValue(v: unknown, pointer: string, errs: string[], page?: PageSchema): void {
  if (isPrimitive(v)) return;
  if (isObject(v)) {
    if (v.kind === 'expr') {
      if (typeof v.source !== 'string') errs.push(`${pointer}: expr.source 必须为字符串`);
      return;
    }
    for (const [k, child] of Object.entries(v)) checkPropValue(child, `${pointer}/${k}`, errs, page);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length > 0 && v.every((e) => isObject(e) && typeof e.type === 'string')) {
      for (let i = 0; i < v.length; i++) checkAction(v[i], `${pointer}/${i}`, errs);
      return;
    }
    if (v.length > 0 && v.every((e) => isObject(e) && typeof e.componentName === 'string')) {
      for (let i = 0; i < v.length; i++) checkLayoutNode(v[i], `${pointer}/${i}`, errs, page);
      return;
    }
    for (let i = 0; i < v.length; i++) checkPropValue(v[i], `${pointer}/${i}`, errs, page);
  }
}

const ACTION_TYPES = ['SUBMIT', 'TRIGGER_FLOW', 'CALL_API', 'OPEN_PAGE', 'DELETE', 'CUSTOM_SCRIPT'];
function checkAction(v: Record<string, unknown>, pointer: string, errs: string[]): void {
  if (!ACTION_TYPES.includes(String(v.type))) {
    errs.push(`${pointer}: 未知动作类型 ${String(v.type)}`);
    return;
  }
  const requires: Record<string, string[]> = {
    SUBMIT: ['successBehavior'],
    TRIGGER_FLOW: ['flowId', 'bizKeyFrom'],
    CALL_API: ['apiName', 'paramsMapping'],
    OPEN_PAGE: ['targetPageId', 'queryMapping'],
    DELETE: [],
    CUSTOM_SCRIPT: ['scriptId'],
  };
  for (const key of requires[String(v.type)]) {
    if (v[key] === undefined) errs.push(`${pointer}: 缺少必填字段 ${key}`);
  }
  if (v.type === 'SUBMIT' && !['REFRESH', 'REDIRECT', 'TOAST'].includes(String(v.successBehavior))) {
    errs.push(`${pointer}: SUBMIT.successBehavior 非法`);
  }
}

export function checkLayoutNode(node: unknown, pointer: string, errs: string[], page?: PageSchema): void {
  if (!isObject(node)) {
    errs.push(`${pointer}: LayoutNode 必须为对象`);
    return;
  }
  if (typeof node.id !== 'string' || !node.id) errs.push(`${pointer}: id 必填`);
  if (typeof node.componentName !== 'string' || !PROP_PATTERN.test(node.componentName)) {
    errs.push(`${pointer}: componentName 非法`);
  }
  if (node.fieldRef !== undefined) {
    if (typeof node.fieldRef !== 'string' || !node.fieldRef) {
      errs.push(`${pointer}: fieldRef 必须为非空字符串`);
    } else if (!page) errs.push(`${pointer}: fieldRef 校验需要页面上下文`);
    else if (!page.modelId) errs.push(`${pointer}: fieldRef 需要页面绑定模型`);
    else {
      // 字段存在性属运行时语义（02FE §5：字段上下文由宿主从模型服务拉取，页面协议冻结态
      // 不内嵌 fields）。此处仅当页面携带内嵌 fields（设计器草稿兼容形态）时校验存在性；
      // 引用不存在字段的最终拦截在渲染层（fields.get 未命中渲染 null + design 模式标黄）。
      const fields = collectFields(page);
      if (fields.length > 0 && !fields.includes(String(node.fieldRef))) {
        errs.push(`${pointer}: fieldRef 指向未知字段 ${String(node.fieldRef)}`);
      }
    }
  }
  if (!isObject(node.props)) errs.push(`${pointer}: props 必须为对象`);
  else for (const [k, v] of Object.entries(node.props)) checkPropValue(v, `${pointer}/props/${k}`, errs, page);
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) errs.push(`${pointer}: children 必须为数组`);
    else node.children.forEach((c, i) => checkLayoutNode(c, `${pointer}/children/${i}`, errs, page));
  }
}

function collectFields(page: PageSchema): string[] {
  const keys = page['fields' as keyof PageSchema] as unknown as FieldSchema[] | undefined;
  return Array.isArray(keys) ? keys.map((f) => f.key) : [];
}

const FIELD_TYPES = ['text', 'number', 'date', 'enum', 'boolean', 'file', 'richtext', 'relation', 'geo', 'user', 'dept', 'computed'];
const CARDINALITIES = ['1:1', '1:n', 'n:n'];
const CASCADES = ['FORBID', 'SET_NULL', 'CASCADE_SOFT_DELETE'];
const PERSIST_MODES = ['READ_TIME', 'PERSISTED'];
const ENUM_OPTION_STATUSES = ['ACTIVE', 'DEPRECATED'];
const FIELD_STATUSES = ['ACTIVE', 'DELETED'];

/** 模型校验（01FE §2）：字段类型 12 种冻结枚举、字段状态机、关系/计算字段配置结构 */
export function validateModelSchema(input: unknown): ModelSchema {
  const errs: string[] = [];
  if (!isObject(input)) throw new SchemaValidationError(['/: 必须为对象']);
  if (typeof input.id !== 'string' || !input.id) errs.push('/id: 必填');
  if (typeof input.modelKey !== 'string' || !input.modelKey) errs.push('/modelKey: 必填');
  if (typeof input.name !== 'string' || !input.name) errs.push('/name: 必填');
  if (!Number.isInteger(input.version) || Number(input.version) < 1) errs.push('/version: 必须为正整数');
  if (!Number.isInteger(input.schemaVersion) || Number(input.schemaVersion) < 1) errs.push('/schemaVersion: 必须为正整数');
  if (!Array.isArray(input.fields)) errs.push('/fields: 必须为数组');
  else {
    const seen = new Set<string>();
    (input.fields as unknown[]).forEach((f, i) => {
      const pointer = `/fields/${i}`;
      if (!isObject(f)) { errs.push(`${pointer}: 字段必须为对象`); return; }
      for (const key of ['key', 'label', 'type', 'fieldStatus', 'sortOrder']) {
        if (f[key] === undefined) errs.push(`${pointer}: 缺少必填字段 ${key}`);
      }
      if (typeof f.key === 'string') {
        if (seen.has(f.key)) errs.push(`${pointer}/key: 重复字段 key ${f.key}`);
        seen.add(f.key);
      }
      if (!FIELD_TYPES.includes(String(f.type))) errs.push(`${pointer}/type: 非法字段类型 ${String(f.type)}`);
      if (!FIELD_STATUSES.includes(String(f.fieldStatus))) errs.push(`${pointer}/fieldStatus: 非法字段状态`);
      if (f.enumOptions !== undefined) {
        if (!Array.isArray(f.enumOptions)) errs.push(`${pointer}/enumOptions: 必须为数组`);
        else if (String(f.type) !== 'enum') errs.push(`${pointer}/enumOptions: 仅 enum 类型字段可配置选项`);
        else (f.enumOptions as unknown[]).forEach((o, oi) => {
          if (!isObject(o) || typeof o.value !== 'string' || typeof o.label !== 'string'
            || !ENUM_OPTION_STATUSES.includes(String(o.status))) errs.push(`${pointer}/enumOptions/${oi}: 结构非法`);
        });
      }
      if (f.relation !== undefined) {
        if (String(f.type) !== 'relation') errs.push(`${pointer}/relation: 仅 relation 类型字段可配置关系`);
        else if (!isObject(f.relation) || typeof f.relation.targetModelId !== 'string'
          || !CARDINALITIES.includes(String(f.relation.cardinality))
          || !CASCADES.includes(String(f.relation.cascade))) errs.push(`${pointer}/relation: 结构非法`);
      }
      if (f.computed !== undefined) {
        if (String(f.type) !== 'computed') errs.push(`${pointer}/computed: 仅 computed 类型字段可配置计算表达式`);
        else if (!isObject(f.computed) || !isObject(f.computed.expr) || (f.computed.expr as Record<string, unknown>).kind !== 'expr'
          || typeof (f.computed.expr as Record<string, unknown>).source !== 'string'
          || !Array.isArray(f.computed.dependsOn) || !PERSIST_MODES.includes(String(f.computed.persistMode))) {
          errs.push(`${pointer}/computed: 结构非法`);
        }
      }
    });
  }
  if (errs.length) throw new SchemaValidationError(errs);
  return input as unknown as ModelSchema;
}

export function validatePageSchema(input: unknown): PageSchema {
  const errs: string[] = [];
  if (!isObject(input)) throw new SchemaValidationError(['/: 必须为对象']);
  if (!['FORM', 'LIST', 'DETAIL', 'DASHBOARD'].includes(String(input.type))) errs.push('/type: 非法页面类型');
  if (typeof input.id !== 'string' || !input.id) errs.push('/id: 必填');
  if (typeof input.path !== 'string' || !input.path.startsWith('/')) errs.push('/path: 必须以 / 开头');
  if (typeof input.schemaVersion !== 'number') errs.push('/schemaVersion: 必须为数字');
  if (!Array.isArray(input.layout)) errs.push('/layout: 必须为数组');
  else input.layout.forEach((n, i) => checkLayoutNode(n, `/layout/${i}`, errs, input as unknown as PageSchema));
  if (!Array.isArray(input.actions)) errs.push('/actions: 必须为数组');
  else input.actions.forEach((a, i) => isObject(a) && checkAction(a, `/actions/${i}`, errs));
  if (input.dataSource !== undefined && isObject(input.dataSource)) {
    const ds = input.dataSource;
    if (!['MODEL_LIST', 'MODEL_DETAIL', 'MODEL_AGG', 'STATIC_JSON'].includes(String(ds.type))) {
      errs.push('/dataSource/type: 非法数据源类型');
    }
    if (ds.pagination) {
      const size = (ds.pagination as Record<string, unknown>).size;
      if (!Number.isInteger(size) || Number(size) < 1 || Number(size) > 200) {
        errs.push('/dataSource/pagination/size: 必须在 1..200');
      }
    }
  }
  if (input.scripts !== undefined) {
    const SCRIPT_HOOKS = ['onLoad', 'onFieldChange', 'beforeSubmit', 'afterSubmit', 'onActionClick', 'onBeforeDelete'];
    if (!Array.isArray(input.scripts)) errs.push('/scripts: 必须为数组');
    else {
      const seen = new Set<string>();
      input.scripts.forEach((s, i) => {
        const p = `/scripts/${i}`;
        if (!isObject(s)) { errs.push(`${p}: 必须为对象`); return; }
        if (typeof s.scriptId !== 'string' || !s.scriptId) errs.push(`${p}/scriptId: 必填`);
        if (!SCRIPT_HOOKS.includes(String(s.hook))) errs.push(`${p}/hook: 非法钩子名`);
        if (typeof s.contentHash !== 'string' || !s.contentHash) errs.push(`${p}/contentHash: 必填`);
        if (typeof s.sourceHash !== 'string' || !s.sourceHash) errs.push(`${p}/sourceHash: 必填`);
        if (s.source !== undefined && typeof s.source !== 'string') errs.push(`${p}/source: 可选，必须为字符串`);
        if (seen.has(String(s.hook))) errs.push(`${p}/hook: 同一钩子至多一条绑定`);
        seen.add(String(s.hook));
      });
    }
  }
  if (errs.length) throw new SchemaValidationError(errs);
  return input as unknown as PageSchema;
}

/**
 * FlowSchema 结构校验（spec 020 阶段 A——10FE §2.1 七型节点集）：
 * 形态（flowKey/nodes/edges）→ 节点 ID 唯一 → 边端点存在 → 连通性（START 可达全部）
 * → 网关配对（分支/并行网关必有 MERGE 汇聚）→ 循环拒绝（除网关回边外无环）
 * → 审批人规则（APPROVAL 必填三模式）→ 分支出边与 branches 配对。
 * 只读阶段 A 校验拒绝即不可渲染——画布消费方捕获 SchemaValidationError 展示错误态。
 */
export function validateFlowSchema(input: unknown): FlowSchema {
  const errs: string[] = [];
  if (!isObject(input)) throw new SchemaValidationError(['/: 必须为对象']);
  if (typeof input.flowKey !== 'string' || !input.flowKey) errs.push('/flowKey: 必填');
  if (typeof input.name !== 'string' || !input.name) errs.push('/name: 必填');
  if (typeof input.schemaVersion !== 'number') errs.push('/schemaVersion: 必须为数字');
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) errs.push('/nodes: 非空必填');
  if (!Array.isArray(input.edges)) errs.push('/edges: 必须为数组');
  if (errs.length) throw new SchemaValidationError(errs);

  const nodes = input.nodes as Array<Record<string, unknown>>;
  const edges = input.edges as Array<Record<string, unknown>>;
  const nodeIds = new Set<string>();
  const nodeType = new Map<string, string>();
  nodes.forEach((n, i) => {
    const p = `/nodes/${i}`;
    if (!isObject(n)) { errs.push(`${p}: 必须为对象`); return; }
    if (typeof n.id !== 'string' || !n.id) { errs.push(`${p}/id: 必填`); return; }
    if (nodeIds.has(n.id)) errs.push(`${p}/id: 重复 (${n.id})`);
    nodeIds.add(n.id);
    if (!FLOW_NODE_TYPES.includes(n.type as never)) errs.push(`${p}/type: 未知节点类型 ${String(n.type)}`);
    else nodeType.set(n.id, n.type as string);
    if (n.approver != null) {
      const a = n.approver as Record<string, unknown>;
      if (!APPROVER_RULE_MODES.includes(a.mode as never)) errs.push(`${p}/approver/mode: 未知模式 ${String(a.mode)}`);
      else if (a.mode === 'USER' && (!Array.isArray(a.userIds) || (a.userIds as unknown[]).length === 0)) errs.push(`${p}/approver/userIds: USER 模式必填非空`);
      else if (a.mode === 'DEPT_ROLE' && (!Array.isArray(a.roleKeys) || (a.roleKeys as unknown[]).length === 0)) errs.push(`${p}/approver/roleKeys: DEPT_ROLE 模式必填非空`);
    }
    if (n.branches != null && !Array.isArray(n.branches)) errs.push(`${p}/branches: 必须为数组`);
  });

  const edgeIds = new Set<string>();
  edges.forEach((e, i) => {
    const p = `/edges/${i}`;
    if (!isObject(e)) { errs.push(`${p}: 必须为对象`); return; }
    if (typeof e.id !== 'string' || !e.id) { errs.push(`${p}/id: 必填`); return; }
    if (edgeIds.has(e.id)) errs.push(`${p}/id: 重复`);
    edgeIds.add(e.id);
    if (!nodeIds.has(String(e.from))) errs.push(`${p}/from: 端点不存在 (${String(e.from)})`);
    if (!nodeIds.has(String(e.to))) errs.push(`${p}/to: 端点不存在 (${String(e.to)})`);
    if (e.from === e.to) errs.push(`${p}: 自环边禁止`);
  });

  // START/END 唯一性 + 连通性（START 可达全部节点）
  const starts = nodes.filter((n) => n.type === 'START');
  const ends = nodes.filter((n) => n.type === 'END');
  if (starts.length !== 1) errs.push('/nodes: START 节点必须恰好 1 个');
  if (ends.length === 0) errs.push('/nodes: END 节点至少 1 个');

  if (starts.length === 1 && errs.filter((x) => x.includes('端点不存在')).length === 0) {
    const adj = new Map<string, string[]>();
    edges.forEach((e) => {
      if (!adj.has(e.from as string)) adj.set(e.from as string, []);
      adj.get(e.from as string)!.push(e.to as string);
    });
    const seen = new Set<string>([starts[0].id as string]);
    const queue = [starts[0].id as string];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nxt of adj.get(cur) ?? []) {
        if (!seen.has(nxt)) { seen.add(nxt); queue.push(nxt); }
      }
    }
    for (const id of nodeIds) if (!seen.has(id)) errs.push(`/nodes: 节点不可达 (${id}——START 出发不可及)`);

    // 循环拒绝：全图无环（阶段 A 只读展示——审批流执行期回退边属 B 阶段扩展）
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of nodeIds) color.set(id, WHITE);
    let cyclic = false;
    const dfs = (u: string) => {
      color.set(u, GRAY);
      for (const v of adj.get(u) ?? []) {
        const c = color.get(v) ?? WHITE;
        if (c === GRAY) { cyclic = true; return; }
        if (c === WHITE) dfs(v);
        if (cyclic) return;
      }
      color.set(u, BLACK);
    };
    for (const id of nodeIds) if (color.get(id) === WHITE) dfs(id);
    if (cyclic) errs.push('/edges: 存在循环（阶段 A 只读展示拒绝环形流程）');

    // 网关配对：CONDITION_BRANCH / PARALLEL_GATEWAY 必有对应 MERGE_GATEWAY 汇聚
    const merges = new Set(nodes.filter((n) => n.type === 'MERGE_GATEWAY').map((n) => n.id as string));
    for (const n of nodes) {
      if (n.type !== 'CONDITION_BRANCH' && n.type !== 'PARALLEL_GATEWAY') continue;
      const p = `/nodes/${nodes.indexOf(n)}`;
      const branchOuts = (adj.get(n.id as string) ?? []).filter((t) => merges.has(t));
      if (branchOuts.length === 0) errs.push(`${p}: 网关缺少 MERGE_GATEWAY 汇聚（${n.type}）`);
    }
    // 分支出边配对：CONDITION_BRANCH 出边 branchId 与 branches.id 一一对应
    for (const n of nodes) {
      if (n.type !== 'CONDITION_BRANCH' || !Array.isArray(n.branches)) continue;
      const branchIds = new Set((n.branches as Array<Record<string, unknown>>).map((b) => String(b.id)));
      const outEdges = edges.filter((e) => e.from === n.id);
      for (const e of outEdges) {
        if (e.branchId != null && !branchIds.has(String(e.branchId))) {
          errs.push(`/edges/${edges.indexOf(e)}/branchId: 不在节点 branches 集合内`);
        }
      }
      for (const b of n.branches as Array<Record<string, unknown>>) {
        if (!outEdges.some((e) => String(e.branchId ?? '') === String(b.id))) {
          errs.push(`/nodes/${nodes.indexOf(n)}/branches: 分支 ${String(b.id)} 无对应出边`);
        }
      }
    }
  }

  if (errs.length) throw new SchemaValidationError(errs);
  return input as unknown as FlowSchema;
}
