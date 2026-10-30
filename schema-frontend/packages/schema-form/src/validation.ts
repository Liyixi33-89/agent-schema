/**
 * 校验管线（03FE §4 统一 resolver）：
 * buildRules 编译 FieldSchema.validators → 规则集；validateField 逐条执行。
 * 与后端 WriteValidator 同构（02BE §3.4 双端同判铁律）：
 * range/regex/expression 语义与错误文案对齐（错误码不强制一致——前端是文案，后端是 code）。
 */
import type { FieldSchema } from '@schema/schema-protocol';
import { compile, evaluate } from '@schema/schema-protocol';

export type ValidationRule =
  | { kind: 'required' }
  | { kind: 'range'; min?: number; max?: number }
  | { kind: 'regex'; pattern: string }
  | { kind: 'enum'; values: string[] }
  | { kind: 'expression'; source: string }
  | { kind: 'typeNumber' }
  | { kind: 'typeText' };

/** 规则集编译（03FE §4 ①②③）。validators 为元数据扩展位（01BE §3.4）——宽松读取。 */
export function buildRules(field: FieldSchema): ValidationRule[] {
  const rules: ValidationRule[] = [];
  if (field.type === 'number') rules.push({ kind: 'typeNumber' });
  if (field.type === 'text' || field.type === 'richtext') rules.push({ kind: 'typeText' });
  if (field.type === 'enum' && field.enumOptions) {
    rules.push({ kind: 'enum', values: field.enumOptions.filter((o) => o.status !== 'DEPRECATED').map((o) => o.value) });
  }
  for (const v of (field as unknown as { validators?: unknown[] }).validators ?? []) {
    const validator = v as Record<string, unknown>;
    if (validator['type'] === 'range') {
      rules.push({ kind: 'range', min: num(validator['min']), max: num(validator['max']) });
    } else if (validator['type'] === 'regex' && typeof validator['pattern'] === 'string') {
      rules.push({ kind: 'regex', pattern: validator['pattern'] });
    } else if (validator['type'] === 'expression' && typeof validator['expr'] === 'string') {
      rules.push({ kind: 'expression', source: validator['expr'] });
    }
  }
  return rules;
}

/** 单字段校验（03FE §4 管线执行；uniqueFlag 异步校验由 FormStore.validateUnique 承担）。 */
export function validateField(
  rules: ValidationRule[],
  value: unknown,
  opts: { required: boolean; scope?: Record<string, unknown>; clock?: () => Date },
): string | null {
  const empty = value === undefined || value === null || value === '';
  if (opts.required && empty) return '必填项';
  if (empty) return null; // 非必填空值跳过后续规则（与后端 enforceRequired 语义一致）

  for (const rule of rules) {
    switch (rule.kind) {
      case 'typeNumber':
        if (typeof value !== 'number' || Number.isNaN(value)) return '须为数值';
        break;
      case 'typeText':
        if (typeof value !== 'string') return '须为文本值';
        break;
      case 'range': {
        const n = value as number;
        if (typeof n !== 'number') break;
        if (rule.min !== undefined && n < rule.min) return `不能小于 ${rule.min}`;
        if (rule.max !== undefined && n > rule.max) return `不能大于 ${rule.max}`;
        break;
      }
      case 'regex':
        if (typeof value === 'string' && !new RegExp(rule.pattern).test(value)) return '格式不正确';
        break;
      case 'enum':
        if (!rule.values.includes(String(value))) return '不在可选值范围';
        break;
      case 'expression': {
        // 表达式上下文：value 绑定当前值 + 依赖字段值（与后端 WriteValidator.applyExpression 同构）
        const compiled = compile(rule.source);
        if ('error' in compiled) return '校验器配置非法';
        const scope = { ...(opts.scope ?? {}), value, ...opts.scope };
        const result = evaluate(compiled.ast, scope, opts.clock);
        if ('error' in result) return `校验执行失败: ${result.error.code}`;
        if (result.value === false || result.value === 0 || result.value === null) return '不符合表达式约束';
        break;
      }
    }
  }
  return null;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
