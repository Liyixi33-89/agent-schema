/**
 * 设计器编辑内核（04FE §2/§3）：命令系统 + 撤销重做 + dirty 追踪。
 * 框架无关（零 react/antd 依赖）——全部修改必须经 execute()（可撤销操作唯一入口）。
 *
 * 快照策略（04FE §3）：结构共享不可用时退化为 JSON 快照拷贝——200 节点规模实测 < 1ms，
 * 不引入 immer（规格 §2「不做」：现有栈内自实现）。
 */
import type { FieldSchema, LayoutNode, PageSchema, PageScriptBinding, PropValue } from '@schema/schema-protocol';

/** 撤销栈容量（PRD 02 §3 R6）。 */
export const HISTORY_LIMIT = 50;

export type DesignerCommand =
  | { type: 'insert'; parentId: string | null; index: number; node: LayoutNode }
  | { type: 'moveWithin'; parentId: string | null; fromIndex: number; toIndex: number }
  | { type: 'updateProps'; nodeId: string; patch: Record<string, PropValue> }
  | { type: 'updatePageProps'; patch: Partial<Pick<PageSchema, 'name' | 'path'>> }
  | { type: 'updateScripts'; scripts: PageScriptBinding[] }
  | { type: 'delete'; nodeId: string };

interface HistoryEntry {
  snapshot: PageSchema;
  label: string;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 布局树节点定位（父数组 + 下标）。 */
export function findNode(layout: LayoutNode[], nodeId: string):
  { parent: LayoutNode[]; index: number; node: LayoutNode } | null {
  for (let i = 0; i < layout.length; i++) {
    if (layout[i].id === nodeId) return { parent: layout, index: i, node: layout[i] };
    if (layout[i].children) {
      const hit = findNode(layout[i].children!, nodeId);
      if (hit) return hit;
    }
  }
  return null;
}

function childrenOf(doc: PageSchema, parentId: string | null): LayoutNode[] {
  if (parentId === null) return doc.layout;
  const hit = findNode(doc.layout, parentId);
  if (!hit) throw new Error(`父节点不存在: ${parentId}`);
  if (!hit.node.children) throw new Error(`目标不是容器: ${parentId}`);
  return hit.node.children;
}

/** 深度（根为 1）。 */
export function depthOf(doc: PageSchema, nodeId: string): number {
  const walk = (nodes: LayoutNode[], depth: number): number | null => {
    for (const n of nodes) {
      if (n.id === nodeId) return depth;
      if (n.children) {
        const hit = walk(n.children, depth + 1);
        if (hit != null) return hit;
      }
    }
    return null;
  };
  return walk(doc.layout, 1) ?? -1;
}

/** 以 nodeId 为根收集整棵子树 id（自嵌套判定输入）。 */
export function subtreeIds(node: LayoutNode): Set<string> {
  const ids = new Set<string>([node.id]);
  const walk = (n: LayoutNode): void => {
    for (const c of n.children ?? []) { ids.add(c.id); walk(c); }
  };
  walk(node);
  return ids;
}

/**
 * 落点校验（04FE §4 嵌套校验；返回 ok/reason——不抛异常，由 UI 展示原因）。
 * 规则：目标必须是容器白名单成员（acceptChildren）；深度 ≤ 8；拖动子树时排除自身及后代。
 */
export interface DropCheckContext {
  /** componentName → acceptChildren（物料元数据真源注入）。 */
  acceptsChildren: (componentName: string) => boolean;
  maxDepth?: number;
}

export function validateDropTarget(
  doc: PageSchema,
  targetParentId: string | null,
  draggingIds: string[],
  ctx: DropCheckContext,
): { ok: boolean; reason?: string } {
  const maxDepth = ctx.maxDepth ?? 8;
  if (targetParentId === null) return { ok: true };
  const hit = findNode(doc.layout, targetParentId);
  if (!hit) return { ok: false, reason: '目标节点不存在' };
  if (draggingIds.includes(targetParentId)) return { ok: false, reason: '不能移动到自身内部' };
  if (!ctx.acceptsChildren(hit.node.componentName)) {
    return { ok: false, reason: `物料 ${hit.node.componentName} 不是容器` };
  }
  // 拖动子树不能把祖先放进后代：目标容器的祖先链上若含拖动节点则拒绝
  const ancestors: string[] = [];
  let cur: string | null = targetParentId;
  while (cur != null) {
    ancestors.push(cur);
    cur = findParentOf(doc.layout, cur);
  }
  if (draggingIds.some((id) => ancestors.includes(id))) {
    return { ok: false, reason: '不能移动到自身的子树中' };
  }
  // 深度：目标容器深度 + 1（拖入节点）；拖子树时算子树高度
  const targetDepth = depthOf(doc, targetParentId);
  let subtreeHeight = 1;
  for (const id of draggingIds) {
    const n = findNode(doc.layout, id);
    if (n) subtreeHeight = Math.max(subtreeHeight, heightOf(n.node));
  }
  if (targetDepth + subtreeHeight > maxDepth) {
    return { ok: false, reason: `嵌套深度超过 ${maxDepth} 层` };
  }
  return { ok: true };
}

function heightOf(node: LayoutNode): number {
  if (!node.children?.length) return 1;
  return 1 + Math.max(...node.children.map(heightOf));
}

function findParentOf(layout: LayoutNode[], nodeId: string): string | null {
  for (const n of layout) {
    if (n.children?.some((c) => c.id === nodeId)) return n.id;
    if (n.children) {
      const hit = findParentOf(n.children, nodeId);
      if (hit) return hit;
    }
  }
  return null;
}

/** 编辑器状态机：doc 只读暴露；修改唯一入口 execute()。 */
export class DesignerStore {
  private history: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private _dirty = false;
  /** 保存基线快照（markSaved 时记录——undo/redo 后与当前 doc 比对判定 dirty）。 */
  private savedBaseline: PageSchema | null = null;
  private listeners = new Set<() => void>();

  constructor(private doc: PageSchema) {}

  get document(): PageSchema { return this.doc; }
  get dirty(): boolean { return this._dirty; }
  get canUndo(): boolean { return this.history.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void { for (const fn of this.listeners) fn(); }

  /** dirty 重算：当前 doc 与保存基线（或装载态）深比较。 */
  private recomputeDirty(): void {
    const baseline = this.savedBaseline ?? null;
    this._dirty = baseline === null ? this.history.length > 0 || this._dirty
      : JSON.stringify(this.doc) !== JSON.stringify(baseline);
  }

  /** 用新文档整体替换（外部草稿装载——不进撤销栈，重置历史）。 */
  load(doc: PageSchema): void {
    this.doc = doc;
    this.history = [];
    this.future = [];
    this._dirty = false;
    this.savedBaseline = null;
    this.emit();
  }

  /** 执行命令（可撤销唯一入口）。apply 抛异常时回滚历史栈压入——失败命令不得污染撤销栈。 */
  execute(cmd: DesignerCommand, label?: string): void {
    const entry: HistoryEntry = { snapshot: clone(this.doc), label: label ?? cmd.type };
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    try {
      this.apply(cmd, this.doc);
    } catch (e) {
      // 失败命令：恢复栈顶（弹出刚压入的快照）并原样抛出——doc 未被改动
      const idx = this.history.indexOf(entry);
      if (idx >= 0) this.history.splice(idx, 1);
      throw e;
    }
    this.future = [];
    this._dirty = true;
    this.emit();
  }

  undo(): boolean {
    const entry = this.history.pop();
    if (!entry) return false;
    this.future.push({ snapshot: this.doc, label: entry.label });
    this.doc = entry.snapshot;
    this.recomputeDirty();
    this.emit();
    return true;
  }

  redo(): boolean {
    const entry = this.future.pop();
    if (!entry) return false;
    this.history.push({ snapshot: this.doc, label: entry.label });
    this.doc = entry.snapshot;
    this.recomputeDirty();
    this.emit();
    return true;
  }

  /** 保存成功回执：清 dirty（04FE §3「保存前后状态一致才清 dirty」——调用方须在确认落库后调用）。 */
  markSaved(savedDocument: PageSchema = this.doc): void {
    this.savedBaseline = clone(savedDocument);
    this.recomputeDirty();
    this.emit();
  }

  undoLabel(): string | null { return this.history.at(-1)?.label ?? null; }
  redoLabel(): string | null { return this.future.at(-1)?.label ?? null; }

  /** 应用命令到目标 doc（execute 正向 / 测试复用）。 */
  private apply(cmd: DesignerCommand, doc: PageSchema): void {
    switch (cmd.type) {
      case 'insert': {
        const arr = childrenOf(doc, cmd.parentId);
        const idx = Math.max(0, Math.min(cmd.index, arr.length));
        arr.splice(idx, 0, clone(cmd.node));
        break;
      }
      case 'moveWithin': {
        const arr = childrenOf(doc, cmd.parentId);
        if (cmd.fromIndex < 0 || cmd.fromIndex >= arr.length) throw new Error('fromIndex 越界');
        const [node] = arr.splice(cmd.fromIndex, 1);
        const idx = Math.max(0, Math.min(cmd.toIndex, arr.length));
        arr.splice(idx, 0, node);
        break;
      }
      case 'updateProps': {
        const hit = findNode(doc.layout, cmd.nodeId);
        if (!hit) throw new Error(`节点不存在: ${cmd.nodeId}`);
        for (const [k, v] of Object.entries(cmd.patch)) {
          if (v === undefined) continue;
          if (k === 'fieldRef') {
            // 字段绑定写协议字段（LayoutNode.fieldRef——渲染/校验真源），不进 props
            if (v === '' || v === null) delete hit.node.fieldRef;
            else hit.node.fieldRef = String(v);
            continue;
          }
          hit.node.props = { ...hit.node.props, [k]: v };
        }
        break;
      }
      case 'updatePageProps': {
        Object.assign(doc, cmd.patch);
        break;
      }
      case 'updateScripts': {
        // 整体替换（编译成功回写唯一入口）；同钩子唯一性由协议校验器保证
        doc.scripts = clone(cmd.scripts);
        break;
      }
      case 'delete': {
        const hit = findNode(doc.layout, cmd.nodeId);
        if (!hit) return;
        hit.parent.splice(hit.index, 1);
        break;
      }
    }
  }
}

/**
 * 模型驱动默认页生成（PRD 02 §2.1「由模型生成」）：
 * 按字段顺序单列布局；字段类型 → 物料推断真源 component-materials.defaultWidgetFor；
 * required → FormItem required；enum 选项透传。
 */
export function generateDefaultLayout(
  fields: FieldSchema[],
  deps: { defaultWidgetFor: (fieldType: string) => string; newId: () => string },
): LayoutNode[] {
  const layout: LayoutNode[] = [];
  for (const field of fields) {
    const widget = deps.defaultWidgetFor(field.type);
    const inputProps: Record<string, PropValue> = {};
    if (field.type === 'enum' && field.enumOptions) {
      inputProps.options = field.enumOptions
        .filter((o) => o.status === 'ACTIVE')
        .map((o) => ({ value: o.value, label: o.label }));
    }
    layout.push({
      id: deps.newId(),
      componentName: 'FormItem',
      props: { label: field.label, required: !!field.required },
      children: [{
        id: deps.newId(),
        componentName: widget,
        props: { ...inputProps },
        fieldRef: field.key,
      }],
    });
  }
  return layout;
}

/** 全树 fieldRef 收集（差异检测输入——04FE §6）。 */
export function collectFieldRefs(layout: LayoutNode[]): Set<string> {
  const refs = new Set<string>();
  const walk = (nodes: LayoutNode[]): void => {
    for (const n of nodes) {
      if (n.fieldRef) refs.add(n.fieldRef);
      walk(n.children ?? []);
    }
  };
  walk(layout);
  return refs;
}

/** 大纲树扁平行（渲染输入）。 */
export interface OutlineRow { id: string; componentName: string; label: string; depth: number }

export function outlineOf(layout: LayoutNode[]): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const walk = (nodes: LayoutNode[], depth: number): void => {
    for (const n of nodes) {
      rows.push({
        id: n.id,
        componentName: n.componentName,
        label: String(n.props.label ?? n.componentName),
        depth,
      });
      walk(n.children ?? [], depth + 1);
    }
  };
  walk(layout, 0);
  return rows;
}
