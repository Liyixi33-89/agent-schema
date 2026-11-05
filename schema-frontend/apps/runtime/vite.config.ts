import { defineConfig } from 'vite';

// 子路径部署（schema-nginx.conf /runtime/）：asset 绝对路径必须带 base——
// 缺省 '/' 会误请求根 /assets/ 命中 designer 目录（生产白屏缺陷，本配置即修复）。
export default defineConfig({
  base: '/runtime/',
  build: { chunkSizeWarningLimit: 1600 },
});
