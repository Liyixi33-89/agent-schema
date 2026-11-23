import { defineConfig } from 'vite';

// 子路径部署（schema-nginx.conf /admin/）：asset 绝对路径必须带 base。
// 验收面（ACCEPT_BASE=1）：base='/accept/admin/'——与 designer/runtime 同款验收通道；
// 配合 VITE_API_BASE=/accept 构建注入，应用内请求走 /accept/api（独立验收后端）。
const ACCEPT = process.env.ACCEPT_BASE === '1';

// preview.proxy 仅服务 CI 浏览器冒烟（smoke.yml 用 vite preview 起产物）：
// 生产部署走 nginx，不经过 vite preview，故对本配置无副作用。
const PREVIEW_PROXY = {
  '/api': {
    target: process.env.SMOKE_API_TARGET || 'http://127.0.0.1:18080',
    changeOrigin: true,
    secure: false,
  },
};

export default defineConfig({
  base: ACCEPT ? '/accept/admin/' : '/admin/',
  build: { chunkSizeWarningLimit: 1600, outDir: ACCEPT ? 'dist-accept' : 'dist' },
  preview: { proxy: PREVIEW_PROXY },
});