# 证据驱动工作流

## 使用入口

在项目根目录执行：

```text
python scripts/workflow.py status
python scripts/workflow.py next
python scripts/workflow.py start FIX-M9
python scripts/workflow.py implemented FIX-M9
python scripts/workflow.py check FIX-M9
python scripts/workflow.py accept FIX-M9
python scripts/workflow.py reopen FIX-M9
```

用户可直接派发：「继续下一个可执行任务，按证据验收推进」。这是会话执行约定，不是无人值守后台服务。

## 证据目录规则

验收任务先读 `docs/acceptance/README.md`。新正式证据使用 `docs/acceptance/<work-package>/<run-id>/`，运行输出使用 `scripts/acceptance/out/<run-id>/`（由 `evidence.cjs run` 生成）；历史证据已集中到 `docs/acceptance/<工作包>/legacy/`，旧 `.agent/evidence/` 不再使用。

工具链（`scripts/acceptance/evidence.cjs`）提供 run/archive/check 三类操作：run 生成 run-id 并隔离输出；archive 生成 manifest 与哈希清单；check 校验归档完整性。台账 `check/accept` 会调用 check 并校验：验收项 `commit` 须等于 manifest `sourceCommit`，证据提交可与 HEAD 不同，但 sourceCommit 到 HEAD 之间实现路径不得变更（有变更须重验）；legacy 材料不得用于新验收。工具自测纳入 verify quick 门禁。

## 真源与范围

- `docs/MVP开发任务依赖顺序图.md`：需求与依赖基线，不由此工具修改。
- `.agent/workflow.json`：唯一结构化执行台账，允许维护实时状态；不要在 README/skills 复制进度。
- `.agent/specs/`：详细任务规格。台账中合并里程碑是审查工作包，不代表修改依赖图任务编号。
- 当前 acceptance 是最低审查入口，不是完整需求覆盖证明。每次 start 后先读对应设计小节，拆出完整可测试验收项；跨里程碑工作包须分别覆盖每个子项。
- `implemented` 表示已有代码，不表示通过验收；历史提交不自动转换为 accepted。
- 当前缺失证据全部保留为空，不补造历史报告。分期必须取得人工批准，记录批准范围与出处，不能由 AI 自行把硬要求降级。

## 单任务执行协议

1. 执行 status/next，优先关闭高危缺陷；implemented 任务需显式复核，不会被 next 自动重新实现。
2. start 后读 spec 与设计小节；列齐验收项与负例，补详细 spec，然后最小修改。
3. 跑 lint、目标测试与 verify；HTTP/浏览器/并发要求不得用纯函数测试替代。
4. 标记 implemented。提交代码后，以提交 HEAD 跑验证并保留真实报告。
5. 每条 acceptance 写入 evidence：commit、command、report（仓库相对路径）、passed。
6. 由不同审查者核查需求覆盖和报告，填 review；check 只是结构校验，不替代独立审查。
7. accept 检查全部证据对应 HEAD、报告存在、前置 accepted、实现目录无未提交改动。
8. 发现缺陷执行 reopen，撤销本任务证据，并阻塞已验收的下游任务。blocked 需人工核实原因后显式改为 planned；不自动解除。

证据格式（写入对应验收项，不包含凭证或真实用户数据）：

```json
{"commit":"完整提交 SHA","command":"实际运行命令","report":"docs/acceptance/工作包/运行标识/报告.txt","passed":true}
```

独立审查格式：

```json
{"approved":true,"commit":"完整提交 SHA","reviewer":"审查者标识","report":"docs/acceptance/工作包/运行标识/review.md"}
```

报告应包含执行时刻、真实退出码、测试数量和结果，不得通过管道吞掉原命令退出码。证据对应当前 HEAD；代码推进后如需再次验收必须重跑，避免把旧测试用于新代码。

## V2 需求覆盖与批准门禁

所有新的 accept 强制使用 gateVersion=2；历史 accepted 不补造矩阵或审批，不自动升级历史结论。check 对标记 V2 的工作包执行覆盖检查。

流程：需求基线与验收矩阵 → 风险分类 → 实现与分层测试 → 业务闭环验收 → 独立代码/测试评审 → 修复与重验 → 归档证据 → accepted。

台账 requirements 每项包括：id、source（基线出处）、condition（可观察结果）、risk（low/high）、implementation、tests、negativeTests、checks（acceptance ID 列表）、verification（unit/integration/browser）、status（pending/passed/deferred）。真实用户交互项必须 userInteraction=true、verification=browser、interaction=native；私有 handler 调用属于模拟，不得冒充真实交互。高风险项必须登记负例。延期必须 deferral={approvedBy,reference,owner,workPackage}；实现者不能自行降级需求。

review 必须记录 reviewer、kind（human/independent-session）、approvalReference、scope=[requirements,code,tests,evidence]、findings（blocking/status）及既有 commit/report/approved。implementedBy 与 reviewer 必须不同；自检不构成独立批准。阻塞发现未 resolved 禁止 accepted。

浏览器关键场景遵循：操作 → 等待明确完成 → 界面结果 → 服务端结果 → 重开验证。计数 PASS 不表示需求完成率；missing 仅表示缺少 evidence 引用，不表示功能缺口数。失败命令须保留真实退出码，不能根据 PASS 文案或 stderr 推断成功。

V2 每条 acceptance 必须登记 scenarios（稳定场景 ID 列表）。工具从 manifest 哈希覆盖的 <suite>-result.json 检查每个必需场景实际存在且 pass=true，拒绝重复或缺失 ID；结果可使用 id 或既有 name 字段。

每条 evidence 必须登记 provenance（归档内相对 JSON 路径且被 manifest 哈希覆盖），结构为 {sourceCommit,products:[{name,sourceCommit,sha256,runtimeVersion}]}。工具检查完整 SHA、SHA256 格式与来源一致性；运行人员必须从实际被测产物采集哈希和服务版本，不能拿当前源码版本替代运行版本。该门禁检查记录一致性，不会远程探测部署或证明哈希采集真实。

受控构建：`node scripts/acceptance/evidence.cjs build <配置相对路径> -- <可执行文件> <参数...>`，配置包含 products:[{name,path}]。从干净 Git 树执行实际构建，非零退出或构建期间源码变化拒绝生成成功记录；自动生成 out/builds/<build-id>.json，记录命令、源码 SHA 与产物哈希。运行验收时设置 ACCEPT_BUILD_RECORD 指向该构建记录，运行器前后分别复算哈希，产物改变则验收退出码为 1。归档加入 products.json 和 <suite>-product-check.json。localBuildVersion 仅表示本地构建，不得冒充 runtimeVersion；实际部署端探测仍需接线，因此仅有本地构建记录不能通过完整 V2 产物来源批准。

实际本地产物采集：`node scripts/acceptance/evidence.cjs products <run-id> <config-relative-path>`。配置为 {products:[{name,path,sourceCommit,runtimeVersion}]}，path 必须是仓库内实际被测文件。采集器计算 SHA256/字节数/采集时间，拒绝路径逃逸、重复名称、来源不符及覆盖，生成运行目录 products.json；正式归档时将其加入 --files。应在测试前采集，并在测试后核对产物未变化；目前采集器不自动验证构建来源、部署端版本或测试期间产物变化。目录型 dist 应选择实际加载的 bundle 文件逐项登记，不能仅哈希 index.html 代表整个应用。

V2 evidence 新增 stability 与 deployment 引用，二者须被 manifest 哈希覆盖：stability={sourceCommit,unchanged:true}；deployment={sourceCommit,unchanged:true,targets:[{method:'http-response-sha256',expected,before,after}]}。三个哈希必须一致。部署首次采样工具：`node scripts/acceptance/evidence.cjs deployment <配置相对路径> <out相对输出路径>`，配置 targets:[{name,url,artifact}]。工具实际请求 HTTP 资源并与本地文件 SHA256 比较，拒绝错误响应、重定向、带凭证或查询参数的 URL；首次采样明确 unchanged=false，不能用于批准。CLI run 设置 ACCEPT_DEPLOYMENT_CONFIG 为仓库内配置相对路径后，自动执行前置采样、验收命令、后置采样比较；仅实际响应前后一致且对上产物哈希才生成 <suite>-deployment.json 的 unchanged=true，变化导致运行退出码及 run.json 套件退出码为 1。归档登记该文件并将 evidence.deployment 指向它。前后采样只能检测采样时的差异，不能检测中途替换后恢复的情况；静态资源验证不能代表运行中的 Java 进程版本。

accept 新增实时 GitHub 审批验证：review.github={repository:'owner/repo',pullRequest:正整数,requiredChecks:['实际check名称']}，review.reviewer 使用 GitHub 登录名，review.commit 必须等于当前 PR HEAD。实际查询 PR/reviews/check-runs，批准人不能是 PR 作者，并须经 GitHub collaborators permission 查询具有 write/maintain/admin 权限；批准必须覆盖当前 SHA，无 CHANGES_REQUESTED 且指定 checks 最新一次运行全部成功。API 不可用或数据达到分页上限时失败关闭；令牌仅从 GITHUB_TOKEN/GH_TOKEN 环境变量读取，不落盘。check 仍为本地材料校验，不代表 GitHub 批准；本地 accept 校验不是 GitHub 分支保护，服务器端 ruleset 仍需管理员配置。公开仓库可匿名查询，私有仓库需有读取权限的令牌。

后端运行实例接口：认证保护的 GET /api/system/build-identity。控制器启动时固定读取类路径 build-source.txt，返回 sourceCommit/instanceId；无标识时返回 503/verifiable=false，不能把未注入构建当作来源可验证。受控构建配置 backendIdentity=true 时临时注入资源，构建结束清理；构建命令必须执行 Maven clean package，避免旧 target/classes 中身份资源污染。受控构建对配置中的 JAR 用 Python zipfile 检查 BOOT-INF/classes/build-source.txt 与来源 SHA 一致，不符即拒绝构建记录。部署 targets 可配置 {name,url,kind:'backend-identity',cookieEnv:'环境变量名'}，认证 Cookie 仅从环境读取且不归档；自动核对运行进程 sourceCommit 与当前源码、前后 instanceId 一致，换进程或旧版本拒绝。该分支已接线，但尚未完成带注入标识的真实后端运行联调，不能将旧环境视为已验证。

结构门禁不能证明清单覆盖基线；运行中后端认证探测、受保护分支配置与专项变异测试尚需后续实现，不能宣称已自动保障。

## 自动化边界

脚本不运行测试、不验证人工报告真实性、不保证需求清单完整、不自动提交或推送。
独立审查者、人工分期决策和上线批准不可由实现者勾选替代。CI 绿只证明所运行测试通过。
M16 可提前执行，外部试点必须同时满足 M15/M16 accepted 和人工上线评审。
新增依赖、配置、DDL、docs 基线修改仍遵守项目授权规则。
