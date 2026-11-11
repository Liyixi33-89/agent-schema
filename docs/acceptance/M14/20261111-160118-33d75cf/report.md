# M14 G7 安全验收 · 终轮全链证据（run 20261111-160118-33d75cf）

- 执行时间：2026-11-11 16:01–16:03（UTC+8）
- 源码版本：33d75cf2e31774016b6e2b95dede44c391b95f4e（干净树——run.json workingTreeClean=true）
- 与上轮（20261111-154305-6b180ed）差异：上轮验收脚本改造与验收同轮执行（树不干净，workingTreeClean=false 如实记录），按 V2 门禁「实现变化须重验」要求，脚本改造以 33d75cf 提交后重跑本轮终验；上轮归档保留作过程记录，结论以本轮为准
- 门禁前置：verify[commit] 11 步全绿 exit=0（2026-11-11 15:19–15:21 独立执行：doc-anti-corruption / frontend-tsc / backend-compile / contract-diff / evidence-gate-test(25) / workflow-gate-test / frontend-build / frontend-test / backend-test / backend-it / acceptance-archives）

## 受控构建与部署核实（产物来源）

- 受控构建记录：`out/builds/20261111-155946-33d75cf.json`（evidence build 从干净树 33d75cf 执行；backendIdentity=true，JAR 内 build-source.txt=33d75cf 校验通过）
- 产物：designer-accept sha256=28cd68af…2843（391B）；accept-backend sha256=68ef793c…f0b0（24,988,255B）
- 运行实例身份：`/api/system/build-identity` → sourceCommit=33d75cf、verifiable=true、instanceId=3f52eb04-…（被测即所建）
- 静态面：本地 8090 代理服务 33d75cf 构建的 dist；部署探测 sha256 前后一致（07bbd538…）
- DB：schema_accept 库 Flyway 16 迁移与源码一致

## 套件结果（同一 run-id）

| 套件 | 结果 | 说明 |
|---|---|---|
| g7-api | 6/6 PASS exit=0 | 注册名清单/真实数据查询/未注册 422/畸形 params 容错/无凭证 401/凭证三件套 |
| g7-browser | 16/16 PASS exit=0 | 断言明细见 g7-browser-result.json 与下表 |

### g7-browser 场景 → 需求矩阵映射

| 矩阵域 | 场景断言（result.json 名称前缀） | 结果 |
|---|---|---|
| redline-scan | RED-POS 合法源码编译通过；RED-NEG self.fetch 保存期拒绝（ENV_ESCAPE 422） | PASS |
| build-pipeline | BLD-测试脚本编译成功（产物 + contentHash 回写） | PASS |
| page-binding-persistence | PERSIST-绑定随草稿保存（4 钩子）；PERSIST-发布携带绑定；PERSIST-重开 runtime 钩子执行（刷新恢复） | PASS |
| message-bridge | BRG-消息桥真实往返（onLoad → ui.toast 渲染进 DOM）；BRG-api.call 宿主代理真实返回 | PASS |
| worker-isolation | ISO-运行期能力剥夺（fetch/XHR/eval/Function 不可达）；ISO-onFieldChange 连续输入页面存活；ISO-页面无预期外 console 错误 | PASS |
| hard-interrupt | TERM-页面可交互；TERM-Worker 死循环 terminate（主线程 alive）；TERM-页面无白屏 | PASS |
| publish-isolation | PUB-草稿清空不影响发布版本（发布快照 scripts 独立保留） | PASS |

截图：`shots/g7-browser/01-g7-page-loaded.png`、`02-g7-probe-toast.png`（toast 可见）、`03-g7-after-deadloop.png`（死循环终止后页面完好）、`04-g7-refresh-restored.png`。

## 部署稳定性（deployment 采样）

- runtime-static：http-response-sha256 before=after=07bbd538…
- backend-identity：before=after=33d75cf、实例 UUID 前后一致（3f52eb04）——验收期间部署未变化

## 边界如实登记

- 公网验收面（111.231.57.177/accept/）本轮未重新部署——本轮验收面为本地栈（8090 代理 + 18080 后端 + WSL PG），受控构建身份核实链路完整
- 死循环源码保存期不拦截为架构口径（静态不可判定终止性），运行期 terminate 兜底已实测
- onFieldChange 50ms 节流合并计数精由 script-host 单测覆盖（浏览器侧断言页面存活）
- 上轮 run 20261111-154305-6b180ed（16/16 过但树不干净）保留归档作过程记录；两轮实现与产物一致（scripts/docs 外无代码变化）
