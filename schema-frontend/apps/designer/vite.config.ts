import { defineConfig } from 'vite';

// 子路径部署（schema-nginx.conf /designer/）：asset 绝对路径必须带 base——
// 缺省 '/' 会请求根 /assets/ 命中 runtime 目录（生产白屏缺陷，本配置即修复）。
// 验收面（M13）：ACCEPT_BASE=1 时 base='/accept/designer/'——服务器 80 的验收路径下，
// 资源与 /accept/api/ 反代均独立于生产（与 staging/accept 目录物理隔离）。
const ACCEPT = process.env.ACCEPT_BASE === '1';
export default defineConfig({
  base: ACCEPT ? '/accept/designer/' : '/designer/',
  build: { chunkSizeWarningLimit: 1600, outDir: ACCEPT ? 'dist-accept' : 'dist' },
});
