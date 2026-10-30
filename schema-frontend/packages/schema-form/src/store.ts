/**
 * FormStore（03FE §2 受控状态树 + §4 校验管线）：
 * 表单值域 + 校验状态 + 联动 effect 图的唯一真源。
 * 底层复用 schema-renderer 的 RenderScope（字段级订阅内核——03FE §6 集成契约：
 * ctx.form.get/set 即本 store；L2 脚本写入走 set 自动触发联动与重渲染）。
 */
import { RenderScope } from '@schema/schema-renderer';
import type { FieldSchema } from '@schema/schema-protocol';
import { buildReactions, type ReactionGraph } from './reactions';
import { buildRules, validateField, type ValidationRule } from './validation';

export interface FieldEffect {
  visible: boolean;
  disabled: boolean;
  required: boolean;
  /** 选项过滤结果（optionsFilter 求值产物）。 */
  filteredOptions?: { value: string; label: string }[];
}

export interface FormStoreOptions {
  fields: FieldSchema[];
  /** 表达式求值时钟（测试注入）。 */
  clock?: () => Date;
  /** 异步唯一性校验器（03FE §4 ④——宿主注入请求层实现）。 */
  uniqueChecker?: (fieldKey: string, value: unknown) => Promise<boolean>;
}

/** effect 通知通道（RenderScope 命名订阅——与字段值订阅隔离）。 */
const FIELD_EFFECT_CHANNEL = '__field_effects__';

/** 字段错误通知通道（宿主受控注入消费——组件类型不依赖错误闭包）。 */
export const FIELD_ERROR_CHANNEL = '__field_errors__';

export class FormStore {
  readonly scope = new RenderScope();
  readonly fields: Map<string, FieldSchema>;
  private rules = new Map<string, ValidationRule[]>();
  private reactions: ReactionGraph;
  private effects = new Map<string, FieldEffect>();
  /** 字段错误表（通道分发的真源——宿主不维护平行状态）。 */
  private fieldErrors = new Map<string, string>();
  private clock?: () => Date;
  private uniqueChecker?: FormStoreOptions['uniqueChecker'];
  private uniqueCallIds = new Map<string, number>();
  constructor(options: FormStoreOptions) {
    // DELETED 字段在表单树构建阶段即过滤（03FE §6——values 不含该字段）
    const active = options.fields.filter((f) => f.fieldStatus === 'ACTIVE');
    this.fields = new Map(active.map((f) => [f.key, f]));
    this.clock = options.clock;
    this.uniqueChecker = options.uniqueChecker;
    const built = buildReactions(active);
    // 环检测（03FE §3 构建期）：成环抛错阻断——禁止带环表单进入运行态
    const cycle = built.hasCycle();
    if (cycle) {
      throw new Error(`字段联动存在循环依赖: ${cycle.join(' -> ')}`);
    }
    this.reactions = built;
    for (const f of active) {
      this.rules.set(f.key, buildRules(f));
      this.effects.set(f.key, { visible: true, disabled: false, required: !!f.required });
    }
    // 默认值装载
    for (const f of active) {
      if (f.defaultValue !== undefined) this.scope.set(f.key, f.defaultValue);
    }
    // 初始 effect 求值（2026-10-30 三轮收口）：默认值即可触发 visibleWhen 判定——
    // 此前构造期不重算，首屏 effect 恒为初始字面量，默认值驱动的显隐/必填全失效。
    this.refreshEffects();
  }

  /** 读值（受控组件 value 契约）。 */
  get(fieldKey: string): unknown {
    return this.scope.get(fieldKey);
  }

  /** 写值：自动触发依赖字段的联动 effect 重算（微任务批处理——03FE §3）。 */
  set(fieldKey: string, value: unknown): void {
    this.scope.set(fieldKey, value);
    this.applyReactions(fieldKey);
  }

  /** 批量写（表单回填/详情装载）。 */
  setValues(entries: Record<string, unknown>): void {
    this.scope.setValues(entries);
    for (const key of Object.keys(entries)) this.applyReactions(key);
  }

  /** 字段 effect 状态（显隐/禁用/必填/选项过滤——03FE §3 四种联动的求值产物）。 */
  effectOf(fieldKey: string): FieldEffect {
    return this.effects.get(fieldKey) ?? { visible: true, disabled: false, required: false };
  }

  /**
   * effect 变化订阅（2026-10-30 三轮收口）：
   * 联动重算只更新内部 effects Map 不通知——React 侧无法感知 visibleWhen 翻转。
   * 订阅目标字段的 effect 版本号变化，联动重算后统一通知受影响字段。
   */
  subscribeEffects(fieldKeys: string[], listener: () => void): () => void {
    return this.scope.subscribe(FIELD_EFFECT_CHANNEL, listener, fieldKeys);
  }

  /**
   * 字段错误订阅（2026-10-30 收口——宿主受控注入消费）：
   * 错误经 RenderScope 通道分发——受控包装组件订阅自身 fieldRef 的错误消息，
   * 组件类型不依赖错误状态闭包（避免错误更新重建全部包装组件导致整树重挂载丢焦点）。
   */
  subscribeFieldErrors(fieldKey: string, listener: (message: string | null) => void): () => void {
    let last: string | null = undefined as unknown as string | null;
    return this.scope.subscribeChannel(FIELD_ERROR_CHANNEL, () => {
      const current = this.fieldErrors.get(fieldKey) ?? null;
      const normalized: string | null = current || null;
      if (normalized !== last) {
        last = normalized;
        listener(normalized);
      }
    });
  }

  /**
   * 字段错误批量发布（merge 语义——出现的键覆盖，空串/undefined 清除该字段错误）。
   * 宿主在失焦校验/防抖预检/服务端回填统一走此入口。
   */
  publishErrors(errors: Record<string, string>): void {
    for (const [key, message] of Object.entries(errors)) {
      if (message) {
        this.fieldErrors.set(key, message);
      } else {
        this.fieldErrors.delete(key);
      }
    }
    this.scope.notifyChannel(FIELD_ERROR_CHANNEL);
  }

  /** 手动重算全部 effect（初始化/批量回填后调用）。 */
  refreshEffects(): void {
    for (const [key, field] of this.fields) {
      this.effects.set(key, this.evaluateEffect(field));
    }
  }

  /** 校验管线入口：单字段校验（失焦触发——03FE §4 校验时机）。 */
  validate(fieldKey: string): string | null {
    const field = this.fields.get(fieldKey);
    if (!field) return null;
    const effect = this.effectOf(fieldKey);
    // visibleWhen=false 字段已卸载：不注册校验、不参与提交（03FE §5 语义）
    if (!effect.visible) return null;
    const rules = this.rules.get(fieldKey) ?? [];
    const value = this.get(fieldKey);
    return validateField(rules, value, {
      required: effect.required || !!field.required,
      scope: this.currentScope(),
      clock: this.clock,
    });
  }

  /** 全量校验（提交触发）：返回首个错误（错误定位滚动到第一个错误字段——03FE §4）。 */
  validateAll(): { fieldKey: string; message: string } | null {
    for (const [key] of this.fields) {
      const err = this.validate(key);
      if (err) return { fieldKey: key, message: err };
    }
    return null;
  }

  /** 步骤校验（分步表单——03FE §5：trigger(fieldsOfStep) 通过才允许下一步）。 */
  validateStep(stepFields: string[]): { fieldKey: string; message: string } | null {
    for (const key of stepFields) {
      const err = this.validate(key);
      if (err) return { fieldKey: key, message: err };
    }
    return null;
  }

  /** 异步唯一性校验（03FE §4 ④）：debounce 由宿主控制；此处保证 last-call-wins 竞态防护。 */
  async validateUnique(fieldKey: string, value: unknown): Promise<string | null> {
    if (!this.uniqueChecker) return null;
    const field = this.fields.get(fieldKey);
    if (!field?.uniqueFlag) return null;
    // 隐藏字段跳过（2026-10-30 三轮收口）：visibleWhen=false 已卸载语义（03FE §5）——
    // 未参与提交的字段不应发起远程唯一性探测（省请求且与 serialize 剔除语义一致）。
    if (!this.effectOf(fieldKey).visible) return null;
    if (value === undefined || value === null || value === '') return null;
    const callId = (this.uniqueCallIds.get(fieldKey) ?? 0) + 1;
    this.uniqueCallIds.set(fieldKey, callId);
    const ok = await this.uniqueChecker(fieldKey, value);
    // 竞态防护：旧请求结果丢弃（响应比对 callId——03FE §4 last-call-wins）
    if (this.uniqueCallIds.get(fieldKey) !== callId) return null;
    return ok ? null : '该值已被占用';
  }

  /** 提交序列化：卸载字段不参与提交（03FE §5）；undefined 剔除。 */
  serialize(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key] of this.fields) {
      const effect = this.effectOf(key);
      if (!effect.visible) continue;
      const value = this.get(key);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  /** 全部值（暂存草稿模式——03FE §5：草稿不跑唯一性校验，当前值全量序列化）。 */
  serializeDraft(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key] of this.fields) {
      const value = this.get(key);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  /** 联动重算：字段 A 变化 → graph[A] 逐个 effect 重新求值（03FE §3 依赖编排）。 */
  private applyReactions(changedKey: string): void {
    const targets = this.reactions.dependentsOf(changedKey);
    if (targets.length === 0) return;
    for (const target of targets) {
      const field = this.fields.get(target);
      if (!field) continue;
      const effect = this.evaluateEffect(field);
      this.effects.set(target, effect);
      // 必填变化同步校验规则缓存（requiredWhen 动态增删 required——03FE §3）
      if (effect.required !== this.rules.has(target)) {
        // 规则集本身静态；required 由 validate 入参动态注入——无需重建
      }
    }
    // effect 变化通知（2026-10-30 三轮收口）：订阅目标字段 effect 的组件感知重算完成
    this.scope.notifyChannel(FIELD_EFFECT_CHANNEL, targets);
  }

  /** 求值字段 effect（visibleWhen/disabledWhen/requiredWhen/optionsFilter 四联动）。 */
  private evaluateEffect(field: FieldSchema): FieldEffect {
    const effect: FieldEffect = { visible: true, disabled: false, required: !!field.required };
    const scope = this.currentScope();
    effect.visible = this.evalBinding(field, 'visibleWhen', scope, true);
    effect.disabled = this.evalBinding(field, 'disabledWhen', scope, false);
    effect.required = this.evalBinding(field, 'requiredWhen', scope, !!field.required);
    // optionsFilter 求值（2026-10-30 三轮收口）：此前只建依赖边不求值——
    // 表达式应返回过滤后的 options 数组（或全量透传）。
    effect.filteredOptions = this.evalOptionsFilter(field, scope);
    return effect;
  }

  /**
   * optionsFilter 求值（2026-10-30 三轮收口）：此前只建依赖边不求值。
   * L1 白名单现实约束（无 filter/箭头/三元/对象/数组字面量）——协议语义定版：
   * 表达式产出标量（字符串/数字）= 允许值，静态 options 按精确匹配过滤为单项；
   * 表达式产出 {value,label}[] 或 string[] 数组（若白名单扩展后）= 集合过滤。
   * 标量不命中任何 option → undefined（回落静态全量——不静默清空选项）。
   */
  private evalOptionsFilter(field: FieldSchema, scope: Record<string, unknown>):
      { value: string; label: string }[] | undefined {
    const ext = field as unknown as Record<string, unknown>;
    const binding = ext['optionsFilter'] as
      | { kind?: string; source?: string; dependsOn?: string[] }
      | undefined;
    if (!binding || binding.kind !== 'expr' || typeof binding.source !== 'string') return undefined;
    const staticOptions = (ext['enumOptions'] as { value: string; label: string; status?: string }[] | undefined)
      ?.filter((o) => o.status !== 'DEPRECATED') ?? [];
    const compiled = compileExpr(binding.source);
    if ('error' in compiled) return undefined;
    const result = evaluateExpr(compiled.ast, scope, this.clock);
    if ('error' in result) return undefined;
    const v = result.value;
    // 形态①：{value,label}[] 完整数组直接采纳（白名单扩展后可用）
    if (Array.isArray(v) && v.length > 0 && v.every((o) => !!o && typeof o === 'object'
        && typeof (o as { value?: unknown }).value === 'string')) {
      return v as { value: string; label: string }[];
    }
    // 形态②：value 字符串数组——集合过滤
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      const allowed = new Set(v as string[]);
      const hit = staticOptions.filter((o) => allowed.has(o.value));
      return hit.length ? hit : undefined;
    }
    // 形态③（L1 白名单主路径）：标量 = 允许值——精确匹配过滤为单项
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const target = String(v);
      const hit = staticOptions.filter((o) => o.value === target);
      return hit.length ? hit : undefined;
    }
    return undefined;
  }

  private currentScope(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key] of this.fields) out[key] = this.get(key);
    return out;
  }

  /** ExpressionBinding 求值辅助：失败降级为 fallback（不静默 undefined——错误码可观测）。 */
  private evalBinding(
    field: FieldSchema,
    key: 'visibleWhen' | 'disabledWhen' | 'requiredWhen',
    scope: Record<string, unknown>,
    fallback: boolean,
  ): boolean {
    const binding = (field as unknown as Record<string, unknown>)[key] as
      | { kind: 'expr'; source: string; dependsOn?: string[] }
      | undefined;
    if (!binding) return fallback;
    // 协议扩展说明：visibleWhen 等四联动挂在 FieldSchema 扩展位（01FE §6 契约同步表），
    // 未入 zod 冻结 schema——本包按宽松读取消费，正式化随 schemaVersion 升级走破坏性变更。
    const compiled = compileExpr(binding.source);
    if ('error' in compiled) return fallback;
    const result = evaluateExpr(compiled.ast, scope, this.clock);
    if ('error' in result) return fallback;
    return typeof result.value === 'boolean' ? result.value : fallback;
  }
}

// 协议层求值器间接引用（避免包直接依赖 schema-protocol 的同时保持类型简单）
import { compile as compileExpr, evaluate as evaluateExpr } from '@schema/schema-protocol';
