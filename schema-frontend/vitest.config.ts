import { defineConfig } from 'vitest/config';

/**
 * 前端测试根配置（第二阶段：统一报告与测试发现）。
 *
 * 只做两件事，不改变测试发现规则：
 * 1. 显式声明 include——与 vitest 默认扫描一致（apps/packages/tests 下的 *.test.ts(x)），
 *    显式化是为了让「零文件命中」可被门禁识别（默认值不匹配任何文件时 vitest 仍可能静默通过）。
 * 2. 增加 junit reporter——生成机器可读报告供 CI 上传与统计，
 *    输出路径与 .github/workflows/verify.yml 的上传路径严格一致。
 *
 * ⚠️ 不引入新依赖：junit 是 vitest 内置 reporter。
 * ⚠️ 不在此处设置 environment/globals——沿用各测试文件自身声明，避免改变既有行为。
 */
export default defineConfig({
  test: {
    allowOnly: !process.env.CI,
    include: [
      'apps/**/test/**/*.test.{ts,tsx}',
      'apps/**/src/**/*.test.{ts,tsx}',
      'packages/**/test/**/*.test.{ts,tsx}',
      'packages/**/src/**/*.test.{ts,tsx}',
      'tests/**/*.test.{ts,tsx}',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-accept/**'],
    reporters: process.env.CI
      // CI：默认输出（人读）+ junit（机器读）
      ? ['default', 'junit']
      : ['default'],
    outputFile: {
      // CI 上传路径 = schema-frontend/**/vitest-report.xml（见 verify.yml）
      junit: './vitest-report.xml',
    },
  },
});