/**
 * 表达式设计态校验（PRD 02 §2.2.3）：L1 编译校验真源 schema-protocol.compile——
 * 错误标红阻断保存；正确表达式提取 dependsOn 供保存链路。
 */
import { compile, extractDepends, type ExprNode } from '@schema/schema-protocol';

export interface ExprCheckResult {
  ok: boolean;
  error?: { message: string; line: number; column: number };
  dependsOn?: string[];
}

/**
 * 校验面板表达式输入（支持 `{{ expr }}` 包裹形态——书写习惯宽松化，语义与裸表达式等价）。
 */
export function checkPanelExpr(source: string): ExprCheckResult {
  const trimmed = source.trim();
  if (!trimmed) return { ok: true, dependsOn: [] };
  const unwrapped = trimmed.startsWith('{{') && trimmed.endsWith('}}')
    ? trimmed.slice(2, -2).trim()
    : trimmed;
  const result = compile(unwrapped);
  if ('error' in result) {
    return { ok: false, error: result.error };
  }
  return { ok: true, dependsOn: extractDepends(result.ast as ExprNode) };
}

/** 批量校验节点 props 中的联动表达式（保存前置阻断输入）。 */
export function collectExprErrors(props: Record<string, unknown>, keys: string[]):
  { key: string; message: string }[] {
  const errors: { key: string; message: string }[] = [];
  for (const key of keys) {
    const v = props[key];
    if (typeof v !== 'string' || !v.trim()) continue;
    const r = checkPanelExpr(v);
    if (!r.ok) errors.push({ key, message: `${key}: ${r.error?.message ?? '表达式错误'}（第 ${r.error?.line} 行）` });
  }
  return errors;
}
