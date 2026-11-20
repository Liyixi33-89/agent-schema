/**
 * 冒烟专用 vite 配置（临时——不进主干）：admin-console 本地源码 + 线上验收后端代理。
 *
 * ⚠️ 关键约束（本轮实测发现）：后端 CSRF Cookie 下发 `Path=/accept/`，
 * 浏览器只在该路径前缀下回传。故 admin 冒烟页必须挂在 `/accept/admin/` 下，
 * 否则 document.cookie 读不到 schema_csrf → 登录 403 CSRF_ORIGIN_REJECTED。
 * （线上正式部署 admin 在 `/admin/` 且 API 走根路径，属另一套 nginx 配置。）
 */
import { defineConfig } from 'vite';

const REMOTE = process.env.SMOKE_REMOTE || 'http://111.231.57.177';

export default defineConfig({
  base: '/accept/admin/',
  server: {
    port: 5275,
    strictPort: true,
    proxy: {
      '/accept/api': {
        target: REMOTE,
        changeOrigin: true,
        secure: false,
        headers: { Origin: REMOTE, Referer: `${REMOTE}/accept/admin/` },
      },
    },
  },
});