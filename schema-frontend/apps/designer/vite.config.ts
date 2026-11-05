import { defineConfig } from 'vite';

// 子路径部署（schema-nginx.conf /designer/）：asset 绝对路径必须带 base——
// 缺省 '/' 会请求根 /assets/ 命中 runtime 目录（生产白屏缺陷，本配置即修复）。
export default defineConfig({
  base: '/designer/',
  build: { chunkSizeWarningLimit: 1600 },
});
