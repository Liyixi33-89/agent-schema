# 验收环境 HTTPS 切换预留

临时 HTTP 仅用于合成数据与专用验收账号；公网明文存在密码和会话被窃取风险。当前未配置访问 IP 白名单，不得声明访问已隔离；取得管理员稳定公网 IP 后，对全部 `/accept/` 路由统一配置 allow/deny，测试隧道流量单独确认。

## 切换前提
- 获得浏览器信任的域名证书或 IP SAN 证书，验证证书链和续期方案；自签名仅适合安装信任后的内部客户端。
- 核查后端允许的 HTTPS Origin、代理信任设置及前端 API base，主站与验收后端分别验证。

## nginx 变更
- 新增 443 server：证书、私钥使用服务器受控路径，复制经核查的验收 API 和静态路由，不将占位证书配置直接启用。
- 保留 `proxy_cookie_path / /accept/;`。
- 删除验收 API 下 `proxy_cookie_flags ~^schema_(at|rt|csrf)$ nosecure;`，恢复后端的 Secure；禁止把 nosecure 复制进 443。
- `X-Forwarded-Proto` 使用真实 `$scheme`，不得在 HTTP 伪造 https。
- HTTPS 通过后将 `/accept/` HTTP 入口跳转 HTTPS；HSTS 只在证书和访问范围稳定后启用。

## 验证与回滚
备份 nginx 配置，`nginx -t` 成功后 reload。验证三 Cookie Secure、Path、HttpOnly/SameSite、登录、apps、刷新、登出清除；清除历史 `/` 与 `/api/auth` Cookie，避免主站和验收同名 Cookie 混用。TLS 失败恢复配置备份，HTTP 回退须继续保留风险声明，不能作为生产批准。
