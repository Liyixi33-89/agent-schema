---
spec_id: 015-mvp-closed-loop
status: active
milestone: M15              # 依赖图 §3.12；前置 M8-M10/M11/M12/M13/M14 全部 accepted
created: 2026-11-11
last_verified_at: 2026-11-13
owner: human-lead
---

# Spec · M15 报销登记 MVP 端到端验收

> 真源：《MVP开发任务依赖顺序图》§3.12 M15 行（报销登记 demo + 安全攻防六类）；
> 《详细测试技术文档 02》§1 黄金链路 / §5 攻防六类 / §8 闭环门条件；
> 《PRD-低代码平台产品规划》§5.1 门禁 G1/G2（M15 是 G1 功能验收 + G2 安全基线的证据输入）；
> 08FE §8（G7/L2——M14 已验，本任务只做公网面复核，不重验本地链路）。
> 台账验收项：mvp-demo（建模/页面/权限/发布/表单列表与埋点完整浏览器闭环）、security（攻防项正负例证据）。
> **两项缺口均为验收证据为空，不是功能未实现**——M1-M14 已交付全部单项能力，M15 只做串联与补缺。

## 1. 背景与目标

M15 是 MVP 闭环门：把建模→设计页面→绑定脚本→配置权限→发布→用户登记→列表查询→详情与刷新恢复
串成**一个真实业务（报销登记）**，并在**公网验收环境**上跑通业务套件与安全攻防套件。
串联中暴露的缺口做最小修复并回归；不重造 M1-M14 已交付能力。

历史遗留：M12 `missing=1`（台账 model-designer 验收项 evidence=null、review=null——
2026-11-04/05 验收走 legacy 目录形态，未按正式归档结构登记）。该缺口是**证据登记缺口**，
M12 功能已被 M13/M14 后续验收中的 designer/runtime 回归（37/23 场景）持续覆盖；
本轮处置：在 M15 归档报告中登记说明，不补造历史证据、不改 M12 状态（workflow.md 明令），
M15 业务套件中的 designer 全链回归即为现行有效覆盖证明。

## 2. 范围声明

**做**：
- 报销登记样例定版：模型「报销单」（字段见 §3.1）+ 页面三件（登记表单/记录列表/详情）+ 角色 + 脚本；
- 公网验收环境部署（受控构建产物 + 部署 SHA 登记 + 数据库备份与回滚步骤）；
- 业务端到端套件（mvp-demo）：六场景含正负例，公网真实浏览器执行；
- 安全攻防套件（security）：六类攻防（A1-A6 对应），公网真实行为核验；
- 缺陷最小修复 + 回归测试 + 新版本重验收；
- 归档（report/products/deployment/截图/日志）+ 四维独立审查 + 台账 accepted。

**不做**（防范围蔓延）：
- 审批流闭环（依赖图明确：属 Phase 2 流程引擎验收；登记表单不含审批动作）；
- M16 内容：并发压测（250 并发）、RTO/RPO 备份恢复演练、告警演练、人工上线评审——单独工作包；
- 跨租户渗透测试完整版（L-GA/G8 前外聘；本任务只做 A1-A6 六类自验基线）；
- 正式生产开放（本轮只更新公网**验收环境**）；
- 补造 M12 历史证据（workflow.md §真源与范围：历史缺口不补造）；
- 行级/字段级权限（TC-ISO-03/04 归 P2 门禁，不阻断 M15——测试文档 §8 明示）。

## 3. 报销登记样例定版（产品基线）

### 3.1 模型「报销单」expense（字段最终基线）

沿用 M13/M14 种子链既有模型（expense：title/amount/expenseDate/remark，version=2 已存在），
按 PRD 01 字段类型能力扩充至真实报销场景；**不新建模型、不推倒种子**（复用 id=1 应用「报销管理」）：

| 字段 key | 名称 | 类型 | 约束 | 来源 |
|---|---|---|---|---|
| title | 事由 | text | required, maxLen 50 | 既有种子 |
| amount | 金额 | number | required, min 0.01, max 100000 | 既有种子 |
| expenseDate | 日期 | date | required | 既有种子 |
| category | 类型 | enum | required；options: 差旅/办公用品/招待/培训/其他 | **本轮新增** |
| attachments | 附件 | multiFile | 可选，单文件 ≤10MB（M9 文件服务既有约束） | **本轮新增** |
| remark | 备注 | text | 可选；控件使用 TextArea，textarea 不属于字段类型枚举 | 既有种子 |

新增字段走 M12 已验的两段式保存（precheck→token→saveSchema），版本 v2→v3/v4。

### 3.2 页面三件

| 页面 | 路径 | 内容 | 渲染 |
|---|---|---|---|
| 报销登记（表单） | /apps/1/pages/expense_form | 既有页面（M13/M14 已发布）扩字段绑定 + 附件上传 | FormPageHost |
| 报销记录（列表） | /apps/1/pages/expense_list | DataTable 绑定 expense，列：事由/金额/日期/类型；行点击进详情 | 列表物料（M6-M7 已交付） |
| 报销详情 | /apps/1/pages/expense_detail | DetailView 只读渲染单条记录（含附件下载链接） | 详情物料（M6-M7 已交付） |

### 3.3 角色（按 M11 权限协议，不新增权限模型）

| 操作 | 角色 | 数据范围 |
|---|---|---|
| 建模/设计页面/绑定脚本/发布 | developer（验收账号既有） | 应用「报销管理」 |
| 登记/查看自己的记录 | 普通成员（accept_user） | 本人创建的记录 |
| 查看应用内全部记录 | 应用管理员 | 本应用全部 |

权限协议真源：03BE §3 RBAC + M11 应用成员/角色链（已验）；未授权成员对页面与数据 API 的拒绝语义
在业务套件负例中断言（403/404 按 M11 既有映射）。

### 3.4 脚本（绑定真实业务钩子，M14 能力消费）

登记表单页绑定一段合法 L2 脚本（走既有编译链路 contentHash 回写）：

```js
export async function onLoad(payload, ctx) {
  await ctx.ui.toast('报销登记就绪', 'info');
  return true;
}
export async function onFieldChange(payload, ctx) {
  const amount = Number(await ctx.form.get('amount'));
  if (amount > 50000) await ctx.ui.toast('金额超过 50000，请确认', 'warning');
  return true;
}
export async function beforeSubmit(payload, ctx) {
  const rows = await ctx.api.call('expense-records', { page: 1, size: 1 });
  const remark = await ctx.form.get('remark');
  if (!remark) await ctx.form.set('remark', '已有记录 ' + rows.total + ' 条');
  return true;
}
```

`expense-records` 为 M14 已验的注册名代理通道（g7-api 6/6）；红线负例（self.fetch）沿用既有向量不重跑编译期，
运行期断言钩子真实执行 + toast 渲染 + api.call 返回真实数据。

### 3.5 埋点契约（M8.2 既有链路）

设计器写操作（建模保存/页面保存/发布）落 metering 埋点事件；登录事件 → seat.active。
M15 断言：**发布动作产生对应埋点事件记录**（服务端可查），登记表单提交产生业务数据记录并与埋点事件关联可查
（事件含 tenantId/userId/action 维度——只断言既有 09BE §3-4 契约字段，不新造指标）。

## 4. 验收矩阵（mvp-demo 套件——六场景，每项正例+负例）

| 场景 ID | 内容 | 通过标准（正例） | 负例 |
|---|---|---|---|
| MVP-01 全链建模发布 | 建模扩字段→设计三页→绑定脚本→配置权限→发布 | 三页发布成功，发布版本落库，导航树含三页 | 发布面协议校验失败（缺绑定）被拒 |
| MVP-02 表单登记 | 授权用户填表单提交 | 界面成功提示 + 服务端 API 查到同记录（字段值逐一核对）+ 刷新重开仍存在 | 缺必填（事由/金额/日期/类型空）被拒；金额非法（0/负数/超上限）被拒；**不产生错误记录**（提交前后记录数不变） |
| MVP-03 列表与详情 | 列表页查询→行点击详情 | 列表含已登记记录（含本轮登记）；详情字段与提交一致；附件可下载；刷新恢复 | 未授权用户列表 403/404；跨租户资源 ID 404 |
| MVP-04 脚本运行 | onLoad/onFieldChange/onBeforeSubmit 真实执行 | toast 渲染进 DOM；api.call 返回真实记录数；钩子执行后提交链路正常 | 非法脚本（红线）保存被拒（沿用 M14 向量，不重验编译期） |
| MVP-05 发布隔离 | 修改草稿（改页面布局）不发布 | 已发布页面运行时渲染不受草稿影响；重新发布后生效 | 草稿清空不影响发布版本（M14 PUB 同款断言，公网面复核） |
| MVP-06 埋点核对 | 发布+登记动作的埋点事件 | 服务端可查发布事件记录（tenantId/userId/action 齐）；登记记录创建与埋点维度一致 | 只断页面成功不算过——必须服务端事件记录存在 |

执行链路顺序：建模 → 设计页面 → 绑定脚本 → 配置权限 → 发布 → 用户登记 → 列表查询 → 详情与刷新恢复。

## 5. 安全攻防矩阵（security 套件——六类，每项合法成功+非法拒绝证据）

| 类 | 场景 ID | 用例 | 合法对照 | 非法断言 |
|---|---|---|---|---|
| A1 注入不执行 | SEC-A1 | title 提交 `{{7*7}}`、`<script>alert(1)</script>`、`'+eval('x')+'` | 正常文本字段提交成功存储纯文本 | 渲染为转义文本无脚本执行（DOM 无 script 注入痕迹、无 alert）；表达式按字面量处理 |
| A2 跨站不改数据 | SEC-A2 | XSS payload 经字段/错误路径注入；伪造跨站表单 POST 登记接口 | 正常用户正常提交成功 | tiptap/DOMPurify 既有清洗生效；跨站提交被 CSRF Origin 校验拒（403，不产生记录） |
| A3 CSP 阻断 | SEC-A3 | 产物页注入违规模块加载/内联执行 | 合法静态资源正常加载 | CSP 响应头阻断 + 浏览器 violation（不执行）；公网响应头核验三域策略下发 |
| A4 伪造租户全拒 | SEC-A4 | 合法用户带伪造 X-Tenant-Id；JWT claim 与头不一致 | 正确租户头正常访问 | 403 TENANT_MISMATCH + 审计；不泄露跨租户数据 |
| A5 死循环可终止 | SEC-A5 | 发布页绑定死循环脚本运行期触发 | 合法脚本页面正常（MVP-04 已覆盖为对照） | terminate 3s 内生效（M14 实测 3008ms 口径）；页面无白屏可继续操作 |
| A6 未授权嵌入被拒 | SEC-A6 | 外域 iframe 嵌入公网运行时页面 | 同域 iframe/直访正常 | CSP frame-ancestors 拒；嵌入场景无会话 Cookie 泄露 |

沿用 M14 测试能力（CDP + record() 断言形态），但全部在**公网部署后**核验真实行为；
本地已验项（如 g7-api 注册名通道）只做公网连通性复核不重复全量。

## 6. 部署方案（公网验收环境）

- 环境分离：主站由 schema-platform（18080）及 /opt/schema/current/web 服务；公网验收面由 /accept/api/ 代理独立后端（18081），静态目录为 /opt/schema/staging/accept/{designer,runtime}。先只读确认验收后端启动方式、数据库与编译 Worker 配置；不得以主站发布代替验收面更新，不开放生产；
- 部署 SHA：受控构建登记（evidence.cjs build——前端三应用 bundle + 后端 jar 含 build-source.txt 身份注入）；
- 数据库迁移核查：对比部署前后 Flyway 版本表；有新迁移则先在备份上验证兼容性；
- 备份：部署前 pg_dump 全量 + 旧 jar/web 目录归档（/var/backups/ 模式沿用）；
- 回滚：systemctl stop → 恢复旧 jar/web → start → 冒烟（步骤文档化入部署记录）；
- 上线检查：脚本产物访问（artifactUrl 绝对 URL）、CSP/CORS/认证响应头、HTTPS/80 面可达性；
- deployment.json：三前端 bundle + backend-identity 前后采样一致（evidence.cjs deployment 既有链路）。

## 7. Tasks

- [ ] T1 核对台账缺口（M12 missing=1 定性 + mvp-demo/security 证据空确认）
- [ ] T2 本规格评审定版（human-lead 确认字段基线）
- [ ] T3 编写可重复的 mvp-demo/security 套件，目标地址与账号由环境注入；先在本地执行真实业务主链及安全负例，设计者与业务用户分离，不用管理员替代权限验证
- [ ] T4 修复本轮部署阻断项（前端路径、验收后端/编译 Worker 身份、资源加载检查、备份与迁移回滚边界），受控构建双端产物
- [ ] T5 公网验收面部署（备份→上传→迁移核查→启动→冒烟→deployment 采样），不得更新主站冒充验收面部署
- [ ] T6 对固定部署版本复跑同一套 mvp-demo/security 场景，保留完整正负例及实际退出码
- [ ] T7 缺陷最小修复 + 回归 + 新版本重验（如发现）
- [ ] T8 归档（report/products/deployment/截图/日志 + M12 缺口说明）+ 四维独立审查 + 台账 accepted

## 8. Acceptance

- [ ] A1 mvp-demo 六场景全过（正例+负例断言全 record() 可归档，公网真实浏览器）
- [ ] A2 security 六类攻防全过（每类合法成功+非法拒绝证据物齐备）
- [ ] A3 部署证据：部署 SHA 与受控构建记录一致；deployment 前后采样 unchanged；数据库备份与回滚步骤在案
- [ ] A4 埋点断言含服务端事件记录（不只页面成功）；脚本钩子断言含 api.call 真实返回
- [ ] A5 发现缺陷有最小修复 + 回归测试 + 新版本重验收记录（无缺陷则显式声明）
- [ ] A6 M12 missing=1 处置说明登记（不补造、不改状态、现行覆盖证明引用）
- [ ] A7 verify[commit] 全绿；四维独立审查报告入归档；台账 M15 → accepted（V2 门禁形态）
- [ ] A8 M16 范围（压测/RTO/RPO/上线评审）不在本验收声明中——显式边界

## 9. 验证步骤

```text
1. python scripts/workflow.py start M15
2. node scripts/acceptance/evidence.cjs build scripts/acceptance/build-m15.json -- <构建命令>
3. 部署脚本执行（备份→上传→重启→冒烟）；node scripts/acceptance/evidence.cjs deployment ...
4. node scripts/acceptance/accept-m15-mvp.cjs      # 公网，六场景
5. node scripts/acceptance/accept-m15-security.cjs # 公网，六类攻防
6. powershell -File scripts/verify.ps1 commit
7. 归档 + workflow.py accept M15
```

## 10. 沉淀记录（结项时回填）

- <待回填>
