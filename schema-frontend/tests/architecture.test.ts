import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const config = require('../.dependency-cruiser.cjs');

/** 在临时目录跑 dependency-cruiser，返回 stdout（违规时含规则名）。 */
function cruise(files: Record<string, string>, target = 'packages'): string {
  const dir = mkdtempSync(join(tmpdir(), 'schema-architecture-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, content);
    }
    // 必须保留 config.options（tsPreCompilationDeps）——否则 .ts/.tsx 不被解析，规则形同虚设
    writeFileSync(join(dir, 'rules.json'), JSON.stringify({ forbidden: config.forbidden, options: config.options }));
    const cli = join(process.cwd(), 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruise.mjs');
    try {
      execFileSync(process.execPath, [cli, '--config', 'rules.json', target], { cwd: dir, encoding: 'utf8' });
      return '';
    } catch (error) {
      return String((error as { stdout: string }).stdout);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('architecture guard · 包层规则', () => {
  it('rejects a real cross-package protocol import', () => {
    const output = cruise({
      'packages/schema-protocol/src/index.js': "import '../../other/src/index.js';",
      'packages/other/src/index.js': 'export {};',
    });
    expect(output).toContain('protocol-zero-dependencies');
  });
});

describe('architecture guard · 应用内业务边界（总纲 §2.1）', () => {
  it('feature 深路径导入其他 feature 内部文件 → 违规', () => {
    const output = cruise({
      'apps/x/src/features/a/Page.tsx': "import '../b/internal/helper';",
      'apps/x/src/features/b/internal/helper.ts': 'export const h = 1;',
    }, 'apps');
    expect(output).toContain('no-cross-feature-internal-import');
  });

  it('feature 经对方 index.ts 显式导出引用 → 合规', () => {
    const output = cruise({
      'apps/x/src/features/a/Page.tsx': "import { h } from '../b';",
      'apps/x/src/features/b/index.ts': "export { h } from './internal/helper';",
      'apps/x/src/features/b/internal/helper.ts': 'export const h = 1;',
    }, 'apps');
    expect(output).not.toContain('no-cross-feature-internal-import');
  });

  it('同 feature 内部深路径引用 → 合规', () => {
    const output = cruise({
      'apps/x/src/features/a/Page.tsx': "import { h } from './internal/helper';",
      'apps/x/src/features/a/internal/helper.ts': 'export const h = 1;',
    }, 'apps');
    expect(output).not.toContain('no-cross-feature-internal-import');
  });

  it('展示组件直接依赖 api 适配层 → 违规', () => {
    const output = cruise({
      'apps/x/src/features/a/components/Card.tsx': "import { fetchX } from '../api';",
      'apps/x/src/features/a/api.ts': 'export const fetchX = () => 1;',
    }, 'apps');
    expect(output).toContain('no-request-in-presentational-components');
  });
});