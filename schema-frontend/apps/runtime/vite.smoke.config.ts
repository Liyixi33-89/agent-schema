/**
 * 冒烟专用 vite 配置（临时——不进主干）：runtime 本地源码 + 线上验收后端代理。
 * ⚠️ CSRF 三道兜底：代理须把 Origin/Referer 改写为远端源。
 */
import { defineConfig } from 'vite';

const REMOTE = process.env.SMOKE_REMOTE || 'http://111.231.57.177';

export default defineConfig({
  base: '/accept/runtime/',
  server: {
    port: 5274,
    strictPort: true,
    proxy: {
      '/accept/api': {
        target: REMOTE,
        changeOrigin: true,
        secure: false,
        headers: { Origin: REMOTE, Referer: `${REMOTE}/accept/runtime/` },
      },
    },
  },
});