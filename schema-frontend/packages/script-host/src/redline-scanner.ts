/**
 * L2 红线静态扫描器（08FE §3 第二道闸）：保存期 AST 扫描。
 * 规则唯一真源 contract/redlines.json（与后端 build-service 共用，CI 双端同判）。
 * 定位：深度防御——拦截误用与明显恶意代码、缩小审计面；真正的安全边界是 Worker 隔离（§4）。
 */
import * as acorn from 'acorn';
import redlinesJson from '../contract/redlines.json';

export interface RedlineConfig {
  formatVersion: number;
  version: number;
  bannedIdentifiers: string[];
  bannedSyntax: string[];
  importWhitelist: string[];
  rules: Record<string, string>;
}

export interface ScanViolation {
  rule: string;
  message: string;
  line: number;
  column: number;
}

export interface ScanResult {
  allowed: boolean;
  violations: ScanViolation[];
}

let cached: RedlineConfig | null = null;

/** 加载红线真源；不可用时失败关闭（拒绝放行）——绝不以「规则缺失」为由跳过扫描。 */
export function loadRedlines(): RedlineConfig {
  if (cached) return cached;
  const parsed = redlinesJson as unknown as RedlineConfig;
  if (parsed.formatVersion !== 1 || !Array.isArray(parsed.bannedIdentifiers) || !Array.isArray(parsed.importWhitelist)) {
    throw new Error('redlines.json 格式不符（formatVersion=1）');
  }
  cached = parsed;
  return cached;
}

interface LineIndex {
  /** AST 节点 start 偏移 → 1 基行列。 */
  locate(offset: number): { line: number; column: number };
}

function buildLineIndex(source: string): LineIndex {
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  return {
    locate(offset: number): { line: number; column: number } {
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
      }
      return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
    },
  };
}

const ACORN_OPTS: acorn.Options = { ecmaVersion: 'latest', sourceType: 'module' };

/** 扫描脚本源码：语法解析失败 → CompileError（非安全违规，但仍拒绝编译）。 */
export function scanSource(source: string, config = loadRedlines()): ScanResult {
  const violations: ScanViolation[] = [];
  const idx = buildLineIndex(source);
  const push = (rule: string, message: string, offset: number): void => {
    const { line, column } = idx.locate(offset);
    violations.push({ rule, message, line, column });
  };

  let ast: acorn.Node;
  try {
    ast = acorn.parse(source, ACORN_OPTS);
  } catch (e) {
    const err = e as SyntaxError & { pos?: number; loc?: { line: number; column: number } };
    const at = typeof err.pos === 'number' ? err.pos : 0;
    const { line, column } = err.loc ?? idx.locate(at);
    return { allowed: false, violations: [{ rule: 'SYNTAX_ERROR', message: `语法错误: ${err.message}`, line, column }] };
  }

  const banned = new Set(config.bannedIdentifiers);
  const walk = (node: acorn.Node): void => {
    // 动态 import()：acorn 现代形态为 ImportExpression（独立节点而非 CallExpression+Import callee）
    if (node.type === 'ImportExpression' || node.type === 'CallExpression') {
      const call = node as unknown as { callee?: { type: string } };
      if (node.type === 'ImportExpression' || call.callee?.type === 'Import') {
        push('DYNAMIC_IMPORT', '动态 import() 被禁——产物必须是预打包闭包', node.start);
      }
    }
    // with 语句
    if (node.type === 'WithStatement') push('WITH_STMT', 'with 语句被禁——作用域逃逸不可静态分析', node.start);
    // 禁标识符：仅裸引用拦截（读写均拒）；成员访问（如 x.window）不属环境标识符
    if (node.type === 'Identifier') {
      const id = node as unknown as { name: string; start: number };
      if (banned.has(id.name)) {
        const rule = ruleForIdentifier(id.name, config);
        push(rule, `禁用标识符 ${id.name}`, node.start);
      }
    }
    // import 白名单（静态 import/export-from）
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
      const decl = node as unknown as { source?: { value: string; start: number } };
      const spec = decl.source?.value;
      if (spec && !isWhitelisted(spec, config)) {
        push('IMPORT_WHITELIST', `依赖不在白名单: ${spec}`, decl.source!.start);
      }
    }
    // 递归子节点：值可为单节点或节点数组（body/params/arguments 等）
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === 'object' && 'type' in (item as object)) walk(item as acorn.Node);
      } else if (child && typeof child === 'object' && 'type' in (child as object)) {
        walk(child as acorn.Node);
      }
    }
  };

  walk(ast);
  violations.sort((a, b) => a.line - b.line || a.column - b.column);
  return { allowed: violations.length === 0, violations };
}

function ruleForIdentifier(name: string, config: RedlineConfig): string {
  if (name === 'window' || name === 'document') return 'GLOBAL_DOM';
  if (name === 'localStorage' || name === 'sessionStorage') return 'WEB_STORAGE';
  if (name === 'fetch' || name === 'XMLHttpRequest' || name === 'WebSocket') return 'NETWORK_EGRESS';
  if (name === 'eval' || name === 'Function') return 'EVAL_FAMILY';
  return 'ENV_ESCAPE';
}

/** 白名单匹配：精确包名或其子路径（@scope/pkg、@scope/pkg/sub）；裸相对/绝对路径不在白名单语义内；含 .. 穿越直接拒。 */
function isWhitelisted(spec: string, config: RedlineConfig): boolean {
  if (spec.includes('..')) return false;
  if (!spec.startsWith('@')) return config.importWhitelist.includes(spec);
  const base = spec.split('/').slice(0, 2).join('/');
  return config.importWhitelist.includes(spec) || config.importWhitelist.includes(base);
}

/** 全局赋值检测需要声明的变量集合——预遍历收集声明，再对 AssignmentExpression 裸标识符判定。 */
export function scanGlobalAssignment(source: string, config = loadRedlines()): ScanViolation[] {
  const violations: ScanViolation[] = [];
  const idx = buildLineIndex(source);
  let ast: acorn.Node;
  try {
    ast = acorn.parse(source, ACORN_OPTS);
  } catch {
    return violations; // 语法错误由 scanSource 报告
  }
  const declared = new Set<string>();
  const collectDeclarations = (node: acorn.Node): void => {
    if (node.type === 'VariableDeclarator') {
      const id = (node as unknown as { id: { name?: string } }).id;
      if (id?.name) declared.add(id.name);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === 'object' && 'type' in (item as object)) collectDeclarations(item as acorn.Node);
      } else if (child && typeof child === 'object' && 'type' in (child as object)) {
        collectDeclarations(child as acorn.Node);
      }
    }
  };
  collectDeclarations(ast);
  const walkAssign = (node: acorn.Node): void => {
    if (node.type === 'AssignmentExpression') {
      const expr = node as unknown as { left: { type: string; name?: string } };
      if (expr.left.type === 'Identifier' && expr.left.name && !declared.has(expr.left.name)) {
        const offset = node.start;
        const { line, column } = idx.locate(offset);
        violations.push({
          rule: 'GLOBAL_ASSIGNMENT',
          message: `向未声明变量 ${expr.left.name} 赋值（隐式全局写入）`,
          line, column,
        });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === 'object' && 'type' in (item as object)) walkAssign(item as acorn.Node);
      } else if (child && typeof child === 'object' && 'type' in (child as object)) {
        walkAssign(child as acorn.Node);
      }
    }
  };
  walkAssign(ast);
  void config;
  return violations;
}
