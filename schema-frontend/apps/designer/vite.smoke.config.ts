/**
 * 冒烟专用 vite 配置（临时——不进主干）：
 * 本地 dev server 提供最新源码，/accept/api 反向代理到公网验收后端。
 * 用途：线上部署产物落后于 master 时，用本地代码 + 线上后端做真实链路冒烟。
 *
 * ⚠️ CSRF 三道兜底（03BE）：后端校验 Origin 必须与公网源一致，
 * 故代理须把 Origin/Referer 改写为远端源，否则登录直接 CSRF_ORIGIN_REJECTED。
 */
import { defineConfig } from 'vite';

const REMOTE = process.env.SMOKE_REMOTE || 'http://111.231.57.177';

export default defineConfig({
  base: '/accept/designer/',
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/accept/api': {
        target: REMOTE,
        changeOrigin: true,
        secure: false,
        headers: {
          // 后端 CsrfFilter 按 Origin 白名单校验——改写为远端源
          Origin: REMOTE,
          Referer: `${REMOTE}/accept/designer/`,
        },
      },
    },
  },
});