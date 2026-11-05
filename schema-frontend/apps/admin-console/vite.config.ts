import { defineConfig } from 'vite';

// 子路径部署（schema-nginx.conf /admin/）：asset 绝对路径必须带 base。
export default defineConfig({
  base: '/admin/',
  build: { chunkSizeWarningLimit: 1600 },
});
