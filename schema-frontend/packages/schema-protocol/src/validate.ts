import type { FieldSchema, LayoutNode, PageSchema } from './types';

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
    if (!page) errs.push(`${pointer}: fieldRef 校验需要页面上下文`);
    else if (!page.modelId) errs.push(`${pointer}: fieldRef 需要页面绑定模型`);
    else {
      // 引用不存在的字段是非法配置；DELETED 字段属渲染层过滤，不算结构错误
      const fields = collectFields(page);
      if (!fields.includes(String(node.fieldRef))) errs.push(`${pointer}: fieldRef 指向未知字段 ${String(node.fieldRef)}`);
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
  if (errs.length) throw new SchemaValidationError(errs);
  return input as unknown as PageSchema;
}
