module.exports = {
  forbidden: [
    { name: 'protocol-zero-dependencies', severity: 'error', from: { path: '^packages/schema-protocol/src/' }, to: { pathNot: '^packages/schema-protocol/src/' } },
    { name: 'no-package-to-app', severity: 'error', from: { path: '^packages/' }, to: { path: '^apps/' } },
    { name: 'no-cross-package-relative-import', severity: 'error', from: { path: '^packages/([^/]+)/' }, to: { path: '^packages/', pathNot: '^packages/$1/', dependencyTypes: ['local'] } },
    // 应用内业务边界（前端总纲 §2.1）：feature 之间只允许经对方 index.ts 显式导出引用，
    // 深路径导入其他 feature 内部文件即违规（同 feature 内部引用不受限）。
    {
      name: 'no-cross-feature-internal-import',
      severity: 'error',
      from: { path: '^apps/[^/]+/src/features/([^/]+)/' },
      to: {
        path: '^apps/[^/]+/src/features/',
        pathNot: ['^apps/[^/]+/src/features/$1/', '^apps/[^/]+/src/features/[^/]+/index\\.tsx?$'],
        dependencyTypes: ['local'],
      },
    },
    // 展示组件纯净：features 下的 components/ 不得直接依赖请求层（api 适配）——
    // 数据与回调由上层注入，组件不自行发业务请求。
    {
      name: 'no-request-in-presentational-components',
      severity: 'error',
      from: { path: '^apps/[^/]+/src/features/[^/]+/components/' },
      to: { path: '^apps/[^/]+/src/features/[^/]+/api\\.ts$', dependencyTypes: ['local'] },
    },
  ],
  options: { doNotFollow: { path: 'node_modules' }, tsPreCompilationDeps: true },
};