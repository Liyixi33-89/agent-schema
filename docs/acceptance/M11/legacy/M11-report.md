# M11 验收报告（2026-11-04 · 基线 e664dc5 → 收口 56ecd98）

## 一、验收范围与结论

| 套件 | 结果 | 用例 |
|---|---|---|
| designer 浏览器验收 | PASS | 37/37 |
| runtime 真实提交闭环（恢复暂跳项） | PASS | 23/23 |
| admin-console 管理端 | PASS | 23/23 |
| 缓存与发布隔离专项 | PASS | 23/23 |

完整证据见 `docs/acceptance/`（索引 + 结果 JSON + 原始输出 + 截图；运行期产物现输出至 `scripts/acceptance/out/`，不入 git）。

## 二、验收实证命令

```powershell
# 四套件（Chrome CDP 真实事件 + WSL schema_accept 库 + 8090 代理）
node scripts/acceptance/accept-designer.cjs   # 37/37 PASS
node scripts/acceptance/accept-runtime.cjs    # 23/23 PASS（真实鼠标提交→POST→DB 精确核对→登出失效）
node scripts/acceptance/accept-admin.cjs      # 23/23 PASS（成员/用量/健康/公告 + 越权 + 跨租户）
node scripts/acceptance/accept-cache.cjs      # 23/23 PASS（ETag/304/草稿隔离/发布轮换/预览吊销）

# 后端安全修复回归（WSL PG）
cd schema-platform && mvn -pl bootstrap -am test -Dtest=CookieSessionIT -Dsurefire.failIfNoSpecifiedTests=false
# → Tests run: 12, Failures: 0（含 logoutRevokesAccessTokenToo）

# 完整门禁
powershell -File scripts/verify.ps1 commit   # 七步全绿 PASS (95s)
```

## 三、验收发现并修复的缺陷（本轮 3 个产品级）

1. **登出后旧 access token 存活**（runtime 套件实证：登出 200 但导航接口仍 200）
   → `UserAccount.signOutAllDevices()`（pwdVersion 断链，commit `6a9f283`）
2. **预览会话吊销闭环死锁**（缓存套件实证：三条通道全被拒）
   → 过滤器白名单 + 自我吊销归属校验（commit `e664dc5`）
3. **恒真断言**（独立审查发现：runtime 登录断言无条件 true）
   → 改真实条件断言（commit `56ecd98`）

## 四、协议与回归补强（本轮一并完成）

- fieldRef 三层同判：6 结构样本（minLength 导出进 JSON Schema）+ 1 语义样本
  （模型绑定，semantic 标注）；后端结构层反向锚定（语义约束不得漏进结构导出）（`e93bb02`）
- runtime 回归：validateLoadedFieldRefs 纯逻辑 5 用例 + 表单数值序列化提交 3 用例
- 前端协议 88 测试全绿；后端协议契约测试全绿；表单引擎 32 测试全绿

## 五、剩余限制（如实登记）

- backend-it Windows 侧探活为环境已知误报（WSL 网络半失效）；本体 WSL 内全绿
- 生产资产发布修复（G-04）仅在隔离目录验证合并逻辑；生产部署切换属 M16 上线门禁
- 预览/正式并存同浏览器交互验证覆盖 API 通道级（cookie/token 隔离已断言），
  UI 级 iframe 并存展示未单独截图
