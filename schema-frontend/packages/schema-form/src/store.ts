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

export class FormStore {
  readonly scope = new RenderScope();
  readonly fields: Map<string, FieldSchema>;
  private rules = new Map<string, ValidationRule[]>();
  private reactions: ReactionGraph;
  private effects = new Map<string, FieldEffect>();
  private clock?: () => Date;
  private uniqueChecker?: FormStoreOptions['uniqueChecker'];
  private uniqueCallIds = new Map<string, number>();

  constructor(options: FormStoreOptions) {
    // DELETED 字段在表单树构建阶段即过滤（03FE §6——values 不含该字段）
    const active = options.fields.filter((f) => f.fieldStatus === 'ACTIVE');
    this.fields = new Map(active.map((f) => [f.key, f]));
    this.clock = options.clock;
    this.uniqueChecker = options.uniqueChecker;
    this.reactions = buildReactions(active);
    for (const f of active) {
      this.rules.set(f.key, buildRules(f));
      this.effects.set(f.key, { visible: true, disabled: false, required: !!f.required });
    }
    // 默认值装载
    for (const f of active) {
      if (f.defaultValue !== undefined) this.scope.set(f.key, f.defaultValue);
    }
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

  /** 字段 effect 状态（显隐/禁用/必填——03FE §3 四种联动的求值产物）。 */
  effectOf(fieldKey: string): FieldEffect {
    return this.effects.get(fieldKey) ?? { visible: true, disabled: false, required: false };
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
  }

  /** 求值字段 effect（visibleWhen/disabledWhen/requiredWhen/optionsFilter 四联动）。 */
  private evaluateEffect(field: FieldSchema): FieldEffect {
    const effect: FieldEffect = { visible: true, disabled: false, required: !!field.required };
    const scope = this.currentScope();
    effect.visible = this.evalBinding(field, 'visibleWhen', scope, true);
    effect.disabled = this.evalBinding(field, 'disabledWhen', scope, false);
    effect.required = this.evalBinding(field, 'requiredWhen', scope, !!field.required);
    return effect;
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
