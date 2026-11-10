#!/usr/bin/env node
/**
 * M14 build-worker（04BE §2.3 编译流水线的 Node 侧实现）：
 *   stdin  ← { sourceCode, redlinesPath }
 *   stdout → { ok, contentHash?, code?, errors?: [{line, column, message, code?}] }
 *
 * 铁律（04BE §2.1）：
 *   - 编译过程绝不执行客户代码（只做 acorn AST 扫描 + esbuild 语法转换）；
 *   - 红线规则与前端（08FE §3）共用同一份 redlines.json——同规则文件双端扫描。
 *
 * 调用形态：独立 Node 进程（Java ProcessBuilder 调度）——「Java 进程绝不运行 JS 工具链」。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as acorn from 'acorn';
import * as esbuild from 'esbuild';

const input = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
const { sourceCode, redlinesPath } = input;

const fail = (code, errors) => {
  process.stdout.write(JSON.stringify({ ok: false, code, errors }));
  process.exit(0); // 编译拒绝是正常协议结果，非进程崩溃
};

// ---------- 红线规则加载（失败关闭——规则缺失绝不放行） ----------
let redlines;
try {
  redlines = JSON.parse(readFileSync(redlinesPath, 'utf8'));
  if (redlines.formatVersion !== 1 || !Array.isArray(redlines.bannedIdentifiers)) {
    fail('REDLINE_CONFIG_INVALID', [{ message: 'redlines.json 格式不符（formatVersion=1）' }]);
  }
} catch (e) {
  fail('REDLINE_CONFIG_INVALID', [{ message: `红线规则不可用: ${e.message}` }]);
}

// ---------- ① 静态安全扫描（与前端 redline-scanner.ts 同规则） ----------
const violations = [];
const banned = new Set(redlines.bannedIdentifiers);

const lineIndex = (() => {
  const starts = [0];
  for (let i = 0; i < sourceCode.length; i++) if (sourceCode.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  };
})();

let ast;
try {
  ast = acorn.parse(sourceCode, { ecmaVersion: 'latest', sourceType: 'module' });
} catch (e) {
  const at = typeof e.pos === 'number' ? e.pos : 0;
  const loc = e.loc ?? lineIndex(at);
  fail('SYNTAX_ERROR', [{ line: loc.line, column: loc.column, message: `语法错误: ${e.message}`, code: 'SYNTAX_ERROR' }]);
}

const ruleForIdentifier = (name) => {
  if (name === 'window' || name === 'document') return 'GLOBAL_DOM';
  if (name === 'localStorage' || name === 'sessionStorage') return 'WEB_STORAGE';
  if (name === 'fetch' || name === 'XMLHttpRequest' || name === 'WebSocket') return 'NETWORK_EGRESS';
  if (name === 'eval' || name === 'Function') return 'EVAL_FAMILY';
  return 'ENV_ESCAPE';
};

const isWhitelisted = (spec) => {
  if (spec.includes('..')) return false;
  if (!spec.startsWith('@')) return redlines.importWhitelist.includes(spec);
  const base = spec.split('/').slice(0, 2).join('/');
  return redlines.importWhitelist.includes(spec) || redlines.importWhitelist.includes(base);
};

// 全局赋值检测需要声明集合（预遍历收集，再对裸标识符赋值判定）
const declared = new Set();
const walkNode = (node, visitor) => {
  visitor(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) if (item && typeof item === 'object' && 'type' in item) walkNode(item, visitor);
    } else if (child && typeof child === 'object' && 'type' in child) {
      walkNode(child, visitor);
    }
  }
};

walkNode(ast, (node) => {
  if (node.type === 'VariableDeclarator' && node.id?.name) declared.add(node.id.name);
});

walkNode(ast, (node) => {
  // 动态 import()：acorn 现代形态为 ImportExpression（独立节点）
  if (node.type === 'ImportExpression' || (node.type === 'CallExpression' && node.callee?.type === 'Import')) {
    const { line, column } = lineIndex(node.start);
    violations.push({ rule: 'DYNAMIC_IMPORT', line, column, message: '动态 import() 被禁——产物必须是预打包闭包' });
  }
  if (node.type === 'WithStatement') {
    const { line, column } = lineIndex(node.start);
    violations.push({ rule: 'WITH_STMT', line, column, message: 'with 语句被禁——作用域逃逸不可静态分析' });
  }
  if (node.type === 'Identifier' && banned.has(node.name)) {
    const { line, column } = lineIndex(node.start);
    violations.push({ rule: ruleForIdentifier(node.name), line, column, message: `禁用标识符 ${node.name}` });
  }
  if ((node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration')
      && node.source?.value && !isWhitelisted(node.source.value)) {
    const { line, column } = lineIndex(node.source.start);
    violations.push({ rule: 'IMPORT_WHITELIST', line, column, message: `依赖不在白名单: ${node.source.value}` });
  }
  if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier'
      && node.left.name && !declared.has(node.left.name)) {
    const { line, column } = lineIndex(node.start);
    violations.push({ rule: 'GLOBAL_ASSIGNMENT', line, column, message: `向未声明变量 ${node.left.name} 赋值（隐式全局写入）` });
  }
});

if (violations.length > 0) {
  violations.sort((a, b) => a.line - b.line || a.column - b.column);
  fail('SECURITY_BLOCKED', violations.map((v) => ({
    line: v.line, column: v.column, message: v.message, code: v.rule,
  })));
}

// ---------- ② esbuild 编译（format=esm, target=es2020；产物只含客户代码） ----------
let artifact;
try {
  artifact = await esbuild.transform(sourceCode, {
    format: 'esm',
    target: 'es2020',
    loader: 'ts',
    minify: true,
    logLevel: 'silent',
  });
} catch (e) {
  const errors = (e.errors ?? []).map((err) => ({
    line: err.location?.line, column: err.location?.column,
    message: err.text, code: 'COMPILE_ERROR',
  }));
  fail('COMPILE_FAILED', errors.length > 0 ? errors : [{ message: String(e.message ?? e) }]);
}

// ---------- ③ 产物校验（04BE §2.3③：尺寸上限；钩子导出由消费端按 hook 名验证） ----------
const bytes = Buffer.from(artifact.code, 'utf8');
if (bytes.length > 2 * 1024 * 1024) {
  fail('COMPILE_FAILED', [{ message: `产物超限 ${bytes.length} bytes（上限 2MB）`, code: 'ARTIFACT_TOO_LARGE' }]);
}

// ---------- ④ contentHash（SHA-256；对象键 artifacts/{tenantId}/{hash}.js 由 Java 侧存储） ----------
const contentHash = createHash('sha256').update(bytes).digest('hex');
process.stdout.write(JSON.stringify({ ok: true, contentHash, artifact: artifact.code }));
