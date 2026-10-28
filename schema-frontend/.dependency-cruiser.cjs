module.exports = {
  forbidden: [
    { name: 'protocol-zero-dependencies', severity: 'error', from: { path: '^packages/schema-protocol/src/' }, to: { pathNot: '^packages/schema-protocol/src/' } },
    { name: 'no-package-to-app', severity: 'error', from: { path: '^packages/' }, to: { path: '^apps/' } },
    { name: 'no-cross-package-relative-import', severity: 'error', from: { path: '^packages/([^/]+)/' }, to: { path: '^packages/', pathNot: '^packages/$1/', dependencyTypes: ['local'] } }
  ],
  options: { doNotFollow: { path: 'node_modules' }, tsPreCompilationDeps: true, tsConfig: { fileName: 'tsconfig.base.json' } }
};
