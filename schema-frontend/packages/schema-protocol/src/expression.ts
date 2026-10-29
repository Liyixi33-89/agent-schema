/** L1 受限表达式引擎（01FE §4）：Tokenizer → Pratt Parser → AST → Evaluator，纯函数零依赖 */
export type ExprNode =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'null' }
  | { type: 'ident'; name: string }
  | { type: 'call'; name: string; args: ExprNode[] }
  | { type: 'unary'; op: '!' | '-'; operand: ExprNode }
  | { type: 'binary'; op: string; left: ExprNode; right: ExprNode }
  | { type: 'member'; obj: ExprNode; prop: ExprNode };

export interface CompileError { line: number; column: number; message: string }
export interface Position { pos: number; line: number; column: number }
export type CompileResult = { ast: ExprNode } | { error: CompileError };
export type EvalResult = { value: unknown } | { error: { code: string; message: string } };
export const EVAL_BUDGET = 1000;
export class EvalBudgetError extends Error {
  constructor() { super(`Expression exceeded ${EVAL_BUDGET} evaluation steps`); this.name = 'EvalBudgetError'; }
}
export class FieldMissingError extends Error {
  readonly field: string;
  constructor(field: string) { super(`Referenced field not found: ${field}`); this.name = 'FieldMissingError'; this.field = field; }
}

const KEYWORDS = new Set(['true', 'false', 'null']);
const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1, '&&': 2,
  '==': 3, '!=': 3,
  '>': 4, '>=': 4, '<': 4, '<=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

type Token =
  | { kind: 'num'; value: number; pos: Position }
  | { kind: 'str'; value: string; pos: Position }
  | { kind: 'ident'; value: string; pos: Position }
  | { kind: 'punct'; value: string; pos: Position };

function tokenize(src: string): { tokens: Token[] } | { error: CompileError } {
  const tokens: Token[] = [];
  let pos = 0, line = 1, column = 1;
  const track = (): Position => ({ pos, line, column });
  while (pos < src.length) {
    const ch = src[pos];
    if (ch === '\n') { pos++; line++; column = 1; continue; }
    if (/\s/.test(ch)) { pos++; column++; continue; }
    if (ch === '/' && src[pos + 1] === '/') {
      while (pos < src.length && src[pos] !== '\n') pos++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = track();
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(pos))!;
      pos += m[0].length; column += m[0].length;
      tokens.push({ kind: 'num', value: Number(m[0]), pos: start });
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = track();
      let i = pos + 1, out = '';
      while (i < src.length && src[i] !== ch) {
        if (src[i] === '\\') { out += src[i + 1] ?? ''; i += 2; }
        else { out += src[i]; i++; }
      }
      if (i >= src.length) return { error: { line: start.line, column: start.column, message: '未闭合的字符串' } };
      tokens.push({ kind: 'str', value: out, pos: start });
      pos = i + 1; column = pos - (start.pos - start.column + 1) + 1;
      continue;
    }
    if (/[A-Za-z_\u4e00-\u9fa5]/.test(ch)) {
      const start = track();
      const m = /^[A-Za-z0-9_\u4e00-\u9fa5]+/.exec(src.slice(pos))!;
      pos += m[0].length; column += m[0].length;
      tokens.push({ kind: 'ident', value: m[0], pos: start });
      continue;
    }
    const punct = src.slice(pos).match(/^(===|!==|==|!=|>=|<=|&&|\|\||[-+*/%!<>()[\],.])/);
    if (!punct) return { error: { line, column, message: `非法字符 '${ch}'` } };
    tokens.push({ kind: 'punct', value: punct[0], pos: track() });
    pos += punct[0].length; column += punct[0].length;
  }
  return { tokens };
}

function isCallable(name: string): boolean {
  return !KEYWORDS.has(name);
}

/** 编译：语法层拒绝赋值/箭头函数/成员调用/模板字符串（01FE §4 拒绝项） */
export function compile(source: string): CompileResult {
  const lex = tokenize(source);
  if ('error' in lex) return { error: lex.error };
  const tokens = lex.tokens;
  let idx = 0;
  const peek = (): Token | undefined => tokens[idx];
  const next = (): Token | undefined => tokens[idx++];
  const atPunct = (...vals: string[]): boolean => {
    const t = peek();
    return !!t && t.kind === 'punct' && vals.includes(t.value);
  };

  function parsePrimary(): ExprNode | CompileError {
    const t = next();
    if (!t) return { line: 1, column: source.length + 1, message: '表达式意外结束' };
    if (t.kind === 'num') return { type: 'num', value: t.value };
    if (t.kind === 'str') return { type: 'str', value: t.value };
    if (t.kind === 'ident') {
      if (t.value === 'true') return { type: 'bool', value: true };
      if (t.value === 'false') return { type: 'bool', value: false };
      if (t.value === 'null') return { type: 'null' };
      if (atPunct('(')) {
        if (!isCallable(t.value)) return { line: t.pos.line, column: t.pos.column, message: `标识符 '${t.value}' 不可调用` };
        if (!FUNCTION_NAMES.includes(t.value)) {
          return { line: t.pos.line, column: t.pos.column, message: `非白名单函数: ${t.value}` };
        }
        next();
        const args: ExprNode[] = [];
        if (!atPunct(')')) {
          for (;;) {
            const arg = parseExpr(0);
            if ('message' in arg) return arg;
            args.push(arg);
            if (atPunct(',')) { next(); continue; }
            break;
          }
        }
        if (!atPunct(')')) return { line: t.pos.line, column: t.pos.column, message: `函数 ${t.value} 缺少 ')'` };
        next();
        return { type: 'call', name: t.value, args };
      }
      return { type: 'ident', name: t.value };
    }
    if (t.kind === 'punct') {
      if (t.value === '(') {
        const inner = parseExpr(0);
        if ('message' in inner) return inner;
        if (!atPunct(')')) return { line: t.pos.line, column: t.pos.column, message: "缺少 ')'" };
        next();
        return inner;
      }
      if (t.value === '[') {
        const start = next();
        const arr: ExprNode[] = [];
        if (!atPunct(']')) {
          for (;;) {
            if (!peek() || (peek()!.kind === 'punct' && peek()!.value === ']')) break;
            const el = parseExpr(0);
            if ('message' in el) return el;
            arr.push(el);
            if (atPunct(',')) { next(); continue; }
            break;
          }
        }
        if (!atPunct(']')) return { line: start?.pos.line ?? 1, column: start?.pos.column ?? 1, message: "缺少 ']'" };
        next();
        return { type: 'call', name: '__array', args: arr };
      }
      if (t.value === '-') {
        const operand = parseExpr(7);
        if ('message' in operand) return operand;
        return { type: 'unary', op: '-', operand };
      }
      if (t.value === '!') {
        const operand = parseExpr(7);
        if ('message' in operand) return operand;
        return { type: 'unary', op: '!', operand };
      }
    }
    return { line: t.pos.line, column: t.pos.column, message: `意外的符号 '${(t as Token & { value?: string }).value ?? ''}'` };
  }

  function parseExpr(minPrec: number): ExprNode | CompileError {
    let left = parsePrimary();
    if ('message' in left) return left;
    for (;;) {
      const t = peek();
      if (!t || t.kind !== 'punct') break;
      if (t.value === '=' && tokens[idx + 1]?.kind === 'punct' && (tokens[idx + 1] as { value: string }).value === '>') {
        return { line: t.pos.line, column: t.pos.column, message: '箭头函数不允许（L1 白名单语法）' };
      }
      if (t.value === '=') return { line: t.pos.line, column: t.pos.column, message: '赋值不允许（L1 只读表达式）' };
      if (t.value === '?' && source.includes('`')) {
        return { line: t.pos.line, column: t.pos.column, message: '模板字符串不允许' };
      }
      if (t.value === '.') {
        next();
        const prop = parsePrimary();
        if ('message' in prop) return prop;
        const call = peek();
        if (call && call.kind === 'punct' && call.value === '(') {
          return { line: call.pos.line, column: call.pos.column, message: '成员函数调用不允许（仅白名单全局函数可调用）' };
        }
        left = { type: 'member', obj: left, prop };
        continue;
      }
      if (t.value === '(') {
        return { line: t.pos.line, column: t.pos.column, message: '意外的函数调用（仅白名单全局函数可调用）' };
      }
      const prec = BINARY_PRECEDENCE[t.value];
      if (prec === undefined || prec < minPrec) break;
      next();
      const right = parseExpr(prec + 1);
      if ('message' in right) return right;
      if (left.type === 'member' && (left as { prop?: unknown }).prop !== undefined) {
        // member 作为二元左操作数合法（如 a.b > 1）
      }
      left = { type: 'binary', op: t.value, left, right };
    }
    return left;
  }

  const ast = parseExpr(0);
  if ('message' in ast) return { error: ast };
  const trailing = peek();
  if (trailing) {
    return { error: { line: trailing.pos.line, column: trailing.pos.column, message: '表达式后存在多余内容' } };
  }
  return { ast };
}

/** 提取字段引用（保存时静态分析 → dependsOn） */
export function extractDepends(ast: ExprNode): string[] {
  const found = new Set<string>();
  function walk(node: ExprNode): void {
    if (node.type === 'ident') found.add(node.name);
    else if (node.type === 'call') node.args.forEach(walk);
    else if (node.type === 'unary') walk(node.operand);
    else if (node.type === 'binary') { walk(node.left); walk(node.right); }
    else if (node.type === 'member') { walk(node.obj); walk(node.prop); }
  }
  walk(ast);
  return [...found];
}

type Scope = Record<string, unknown>;
interface EvalContext { scope: Scope; clock?: () => Date; steps: number }

function roundHalfUp(n: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.sign(n) * Math.round(Math.abs(n) * factor + Number.EPSILON) / factor;
}

function formatDate(d: Date, fmt: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return fmt
    .replace(/YYYY/g, String(d.getUTCFullYear()))
    .replace(/MM/g, p(d.getUTCMonth() + 1))
    .replace(/DD/g, p(d.getUTCDate()))
    .replace(/HH/g, p(d.getUTCHours()))
    .replace(/mm/g, p(d.getUTCMinutes()))
    .replace(/ss/g, p(d.getUTCSeconds()));
}

function parseDateLike(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string') {
    const d = new Date(v.length === 10 ? `${v}T00:00:00Z` : v.endsWith('Z') || v.includes('+') ? v : `${v}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** 求值：步数上限、null 传播、短路、UTC 定版语义（01FE §4 向量表） */
export function evaluate(ast: ExprNode, scope: Scope, clock?: () => Date): EvalResult {
  const ctx: EvalContext = { scope, clock, steps: 0 };
  try {
    return { value: evalNode(ast, ctx) };
  } catch (e) {
    if (e instanceof EvalBudgetError || e instanceof FieldMissingError) {
      return { error: { code: e.name, message: e.message } };
    }
    return { error: { code: 'EvalError', message: e instanceof Error ? e.message : String(e) } };
  }
}

function step(ctx: EvalContext): void {
  if (++ctx.steps > EVAL_BUDGET) throw new EvalBudgetError();
}

function evalNode(node: ExprNode, ctx: EvalContext): unknown {
  step(ctx);
  switch (node.type) {
    case 'num': case 'str': case 'bool': return node.value;
    case 'null': return null;
    case 'ident': {
      if (!(node.name in ctx.scope)) throw new FieldMissingError(node.name);
      return ctx.scope[node.name];
    }
    case 'member': {
      const obj = evalNode(node.obj, ctx);
      if (obj === null || obj === undefined) return null;
      const key = String(evalNode(node.prop, ctx));
      return (obj as Record<string, unknown>)[key] ?? null;
    }
    case 'unary': {
      const v = evalNode(node.operand, ctx);
      if (v === null) return null;
      if (node.op === '!') return !truthy(v);
      return -(v as number);
    }
    case 'call': return evalCall(node, ctx);
    case 'binary': return evalBinary(node, ctx);
  }
}

function truthy(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : Boolean(v);
}

function evalBinary(node: Extract<ExprNode, { type: 'binary' }>, ctx: EvalContext): unknown {
  const { op } = node;
  if (op === '&&') {
    const l = evalNode(node.left, ctx);
    return truthy(l) ? evalNode(node.right, ctx) : l;
  }
  if (op === '||') {
    const l = evalNode(node.left, ctx);
    return truthy(l) ? l : evalNode(node.right, ctx);
  }
  const l = evalNode(node.left, ctx);
  const r = evalNode(node.right, ctx);
  if (l === null || r === null) {
    if (op === '==' ) return l === r;
    if (op === '!=') return l !== r;
    return null;
  }
  switch (op) {
    case '+':
      if (typeof l === 'string' || typeof r === 'string') return `${l as string}${r as string}`;
      return (l as number) + (r as number);
    case '-': return (l as number) - (r as number);
    case '*': return (l as number) * (r as number);
    case '/': return (l as number) / (r as number);
    case '%': return (l as number) % (r as number);
    case '==': return l === r;
    case '!=': return l !== r;
    case '>': case '>=': case '<': case '<=':
      if (typeof l !== typeof r) throw new Error(`类型不匹配: ${typeof l} ${op} ${typeof r}`);
      if (typeof l === 'string' || typeof l === 'number') {
        const lv = l as string | number;
        const rv = r as string | number;
        return op === '>' ? lv > rv : op === '>=' ? lv >= rv : op === '<' ? lv < rv : lv <= rv;
      }
      throw new Error(`比较操作不支持类型 ${typeof l}`);
    default: throw new Error(`未知运算符 ${op}`);
  }
}

type Fn = (args: unknown[], ctx: EvalContext) => unknown;
const FUNCTIONS: Record<string, Fn> = {
  __array: (args) => args,
  NOW: (_a, ctx) => (ctx.clock ? ctx.clock() : new Date()),
  DATE_DIFF: ([a, b, unit]) => {
    const da = parseDateLike(a); const db = parseDateLike(b);
    if (!da || !db) return null;
    const ms = da.getTime() - db.getTime();
    const DAY = 86_400_000;
    if (unit === 'DAY') return ms / DAY;
    if (unit === 'WEEK') return ms / (DAY * 7);
    if (unit === 'MONTH') {
      const months = (da.getUTCFullYear() - db.getUTCFullYear()) * 12 + da.getUTCMonth() - db.getUTCMonth();
      return da.getUTCDate() < db.getUTCDate() ? months - 1 : months;
    }
    throw new Error(`DATE_DIFF 不支持单位 ${String(unit)}`);
  },
  DATE_FORMAT: ([d, fmt]) => {
    const date = parseDateLike(d);
    return date ? formatDate(date, String(fmt ?? 'YYYY-MM-DD')) : null;
  },
  CONCAT: (args) => args.filter((v) => v !== null && v !== undefined).map((v) => String(v)).join(''),
  UPPER: ([s]) => (s === null ? null : String(s).toUpperCase()),
  LOWER: ([s]) => (s === null ? null : String(s).toLowerCase()),
  REPLACE: ([s, search, replacement]) => (s === null ? null : String(s).split(String(search)).join(String(replacement))),
  SPLIT: ([s, sep]) => (s === null ? null : String(s).split(String(sep))),
  TRIM: ([s]) => (s === null ? null : String(s).trim()),
  ROUND: ([n, digits]) => (n === null ? null : roundHalfUp(Number(n), Number(digits ?? 0))),
  ABS: ([n]) => (n === null ? null : Math.abs(Number(n))),
  CEIL: ([n]) => (n === null ? null : Math.ceil(Number(n))),
  FLOOR: ([n]) => (n === null ? null : Math.floor(Number(n))),
  INCLUDES: ([list, value]) => (list === null || list === undefined ? false : (list as unknown[]).includes(value)),
  LENGTH: ([target]) => {
    if (target === null || target === undefined) return 0;
    if (typeof target === 'string' || Array.isArray(target)) return target.length;
    return 0;
  },
};

/** 白名单函数注册表与 contract/functions.json 同源（M1.5 CI 校验枚举一致性） */
export const FUNCTION_NAMES: string[] = Object.keys(FUNCTIONS).filter((n) => n !== '__array');

function evalCall(node: Extract<ExprNode, { type: 'call' }>, ctx: EvalContext): unknown {
  if (node.name === '__array') {
    return node.args.map((a) => evalNode(a, ctx));
  }
  const fn = FUNCTIONS[node.name];
  if (!fn) throw new Error(`非白名单函数: ${node.name}`);
  const args = node.args.map((a) => evalNode(a, ctx));
  return fn(args, ctx);
}