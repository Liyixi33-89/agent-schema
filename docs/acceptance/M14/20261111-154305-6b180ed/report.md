# M14 G7 安全验收 · 同轮全链证据（run 20261111-154305-6b180ed）

- 执行时间：2026-11-11 15:43–15:47（UTC+8）
- 源码版本：6b180ed96cf9b3d3f2286f250f2d44ed044a15fc（PR #10 合并后 master；run.json workingTreeClean=false 如实记录——验收脚本自身改造未提交，随本证据一并提交，详见「验收脚本改造」节）
- 门禁前置：verify[commit] 11 步全绿 exit=0（doc-anti-corruption / frontend-tsc / backend-compile / contract-diff / evidence-gate-test 25 测试 / workflow-gate-test / frontend-build / frontend-test / backend-test / backend-it / acceptance-archives 9 manifest）

## 受控构建与部署核实（构建来源）

- 受控构建记录：`out/builds/20261111-151312-6b180ed.json`（evidence build 从干净树 6b180ed 执行；backendIdentity=true，JAR 内 build-source.txt=6b180ed 校验通过）
- 产物：designer-accept sha256=28cd68af…2843（391B）；accept-backend sha256=db309978…06d9（24,988,256B）
- 运行实例身份：`/api/system/build-identity` → sourceCommit=6b180ed、verifiable=true、instanceId=4ff7ce71-…（与受控构建同 SHA——被测即所建）
- 静态面：本地 8090 代理服务 runtime/designer dist（runtime index 引用 index-BRL4oV-6.js 为 6b180ed 构建指纹）；部署探测 sha256 前后一致（07bbd538…）
- DB：schema_accept 库 Flyway 16 迁移与 6b180ed 一致（V16__build_task）

## 套件结果（同一 run-id）

| 套件 | 结果 | 说明 |
|---|---|---|
| g7-api | 6/6 PASS exit=0 | 注册名清单/真实数据查询/未注册 422/畸形 params 容错/无凭证 401/凭证三件套 |
| g7-browser | 16/16 PASS exit=0 | 见下方场景明细 |

### g7-browser 场景 → 需求矩阵映射

| 矩阵域 | 场景（结果 JSON 中的断言名） | 结果 |
|---|---|---|
| redline-scan | RED-POS 合法源码编译通过；RED-NEG self.fetch 保存期拒绝（ENV_ESCAPE 422） | PASS |
| build-pipeline | BLD-测试脚本编译成功（产物 + contentHash=8a0a779e… 回写） | PASS |
| page-binding-persistence | PERSIST-绑定随草稿保存（4 钩子）；PERSIST-发布携带绑定；PERSIST-重开 runtime 钩子执行（刷新恢复） | PASS |
| message-bridge | BRG-消息桥真实往返（onLoad → ui.toast 渲染进 DOM，截图 02 可见 G7PROBE toast）；BRG-api.call 宿主代理真实返回 | PASS |
| worker-isolation | ISO-运行期能力剥夺（fetch/XHR/eval/Function 原型链遮蔽不可达）；ISO-onFieldChange 连续输入页面存活；ISO-页面无预期外 console 错误 | PASS |
| hard-interrupt | TERM-页面可交互（提交按钮可达）；TERM-Worker 死循环 terminate 3008ms 主线程 alive；TERM-页面无白屏（标题「报销登记」仍在，截图 03） | PASS |
| publish-isolation | PUB-草稿清空不影响发布版本（发布快照 scripts=4 条独立保留） | PASS |

关键截图：`shots/g7-browser/01-g7-page-loaded.png`（页面加载）、`02-g7-probe-toast.png`（消息桥 toast 可见）、`03-g7-after-deadloop.png`（死循环终止后页面完好）、`04-g7-refresh-restored.png`（刷新恢复）。

## 部署稳定性（deployment 采样）

- runtime-static：http-response-sha256 before=after=07bbd538…（与本地 dist 一致）
- backend-identity：before=after=6b180ed、实例 UUID 前后一致（4ff7ce71）——验收期间部署未变化

## 验收脚本改造（本轮变更，随证据提交）

1. `accept-g7-browser.cjs`：13 处 `console.log('PASS…')` 断言改为 `ok()/record()` 断言——结果进 results 数组可归档（此前仅登录一项进 result.json 的证据形态缺陷即本轮修复动机）；fail-fast 行为保留（非预期状态仍 throw，exitCode 真实）。
2. `accept-g7-api.cjs`：同构改造（5 断言 + 无凭证独立 401 探测）。
3. `evidence.cjs`：部署探测 fetch 加传输层失败单次重试（800ms 间隔）——首轮 20261111-153309 即因偶发 `fetch failed` 作废（浏览器 16/16 已过但部署 after 采样传输失败，exit=1 如实记录后废弃重跑）；HTTP 状态码错误不重试（真实性不受影响），evidence.test.cjs 25/25 回归通过。
4. 新增 `accept-deploy-local.config.json`（本地部署探测配置：8090 静态面 + 18080 身份接口）与 `accept-products-20261111.config.json`（产物采集配置）。

## 边界如实登记

- 公网验收面（111.231.57.177/accept/）本轮未重新部署——本轮验收面为本地栈（8090 代理 + 18080 后端 + WSL PG），受控构建身份核实链路完整；公网面部署属 M13 遗留形态，不构成 M14 G7 验收缺口
- `workingTreeClean=false`：验收脚本改造在验收后提交（本提交即包含改造与证据）
- onFieldChange 50ms 节流合并计数精理由 script-host 单测覆盖（浏览器侧断言页面存活不炸）
- 死循环源码保存期不拦截为架构口径（静态不可判定终止性），运行期 terminate 兜底已实测（3008ms）
- 废弃 run 20261111-153309-6b180ed 已删除：浏览器套件 16/16 过但部署 after 采样偶发传输失败导致 exit=1，按「不篡改失败记录、全新重跑」原则废弃
