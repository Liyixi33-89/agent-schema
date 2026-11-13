# M15 报销登记 MVP 端到端验收 — 公网终验轮报告（run 20261113-131018-6daa7df）

- 执行时间：2026-11-13 13:10–13:14（UTC+8）
- 套件版本（HEAD）：6daa7dfadbe6b2a7bb1fc64f103eaf7745016ba6（干净树 workingTreeClean=true）
- 被测产物（公网部署面）：
  - 前端 designer/runtime：a6247e1 受控构建（m15pub-002），部署哈希 b3870513… / 0d46a3cc…，
    本轮部署探针（accept-deploy-m15-final.config.json）实测三态一致 unchanged=true；
  - 后端 JAR：7a60b2a 受控构建（out/builds/20261112-185645-7a60b2a.json，backendIdentity=true），
    jar sha256=3f302350…，运行身份冒烟第 3 项实测 sourceCommit=7a60b2a；
  - 编译 Worker：/opt/schema/build-worker/node（Linux 版依赖），冒烟第 4/7 项脚本编译实测运转。
- 版本关系声明：a6247e1 → 6daa7df 之间的 10 个提交**全部在 scripts/acceptance/ 验收工具链内**
  （git diff --name-only a6247e1..HEAD -- schema-frontend schema-platform 为空），
  属验收工具修复与种子数据修正，不改产品实现——被测产物身份以构建记录+部署探针为准。
- 公网通道：企业网对公网 80 明文有中间层拦截，HTTP 流量走 SSH 隧道（127.0.0.1:18100 → 服务器 18082），
  隧道 nginx 已对齐 80 面响应头基线；违规/嵌入探针不可达部分用本机 127.0.0.1（安全组丢弃 18097）。

## 一、套件结果

| 套件 | 断言 | 结果 | 退出码 | 必验缺失 |
| --- | --- | --- | --- | --- |
| m15-security | 30 | 30/30 PASS | 0 | 0 |
| m15-mvp | 54 | 54/54 PASS | 0 | 0 |

双套件零 fail、零 skip、零必验缺失，单 run 同源同版。

## 二、安全六项必验（全部实际执行，无 skip）

1. **A1 注入不执行**：三种载荷按字面量存储/原样返回/DOM 无脚本执行/`{{7*7}}` 不求值（4/4 rows）。
2. **A2 跨站 403**：伪造 Origin 登录被拒 + 写入被拒（CSRF_ORIGIN_REJECTED）。
3. **A3 CSP 强制拦截**：三域响应头基线 + 违规模块被强制拦截（网络可达对照组=true +
   violation 事件=true + 执行标记=false 三要素齐备）+ API 域 Report-Only。
4. **A4 伪造租户拒绝**：伪造 X-Tenant-Id 被拒 + TENANT_MISMATCH 审计落库。
5. **A5 死循环硬中断**：Worker terminate() 硬中断实测（11512ms ≥ 10s 窗口 + 中断后 UI 存活）。
6. **A6 未授权嵌入被拒**：同源 iframe 正常渲染对照组 + 跨源嵌入被拒（渲染差异 +
   浏览器拒绝消息 + XFO + 强制 CSP frame-ancestors）。

## 三、MVP 业务闭环（54 项全链）

- 建模：两段式扩字段（precheck→token→confirmValue→消费）、range 约束真实生效于数据面（422 拒绝）。
- 页面：LIST/DETAIL/FORM 三页发布（真实发布 API），发布埋点落库（usage_event action=publish）。
- 权限：成员角色 API 真实授权链（授权前 0 行 → 授权后可见；SELF 范围外 404 不给线索）。
- 表单：真实浏览器面板交互（日期面板选择 expenseDate=2026-11-13）、提交写入 POST 200、
  落库核对（含租户/创建者）、列表查询、详情打开字段一致、刷新恢复。
- 脚本影响业务：beforeSubmit 经 api.call 读记录数改写 remark 入库（M15脚本注入:提交时已有N条）。
- 回归：M12R 影响面（PAGE_REF 引用登记）+ 回滚链（precheck token → 快照恢复 → 字段集核对）。

## 四、覆盖处置（日期/附件/设计者）

- **日期**：本轮已真实覆盖——MVP02-日期控件面板选择成功（受控值写入输入框，
  expenseDate="2026-11-13" 面板真实交互，非 FILL_JS 污染通道）+ 落库核对 + 详情回显。
- **附件**：FileUpload 物料存在但宿主未注入 uploader（p.uploader undefined → 本地校验态回显，
  fileId 留空）——属真实产品缺口，协议字段类型为 `file`（单文件）。处置：**登记分期**，
  随 M16 后续版本补 uploader 注入与浏览器上传交互验收（spec 与冻结枚举一致，无 multiFile）。
- **设计者浏览器操作**：MVP 套件全部页面构造走设计者真实 API（草稿保存/发布），
  浏览器侧设计器画布交互深度操作已由 M13 台账验收（accepted），M15 复用其结论不重复验。

## 五、部署证据（deployment-evidence.json，服务器实测采集）

- 后端：jar sha256=3f30235016495eca156e0c1c8d40430bbb8278bc5d08f8481513ce9c5e536a07，
  pid=321912 port=18081，运行身份 7a60b2a 与构建记录一致。
- Worker：/opt/schema/build-worker/node，node v20.18.1，脚本编译运转实测（冒烟第 4/7 项）。
- 迁移兼容：flyway V16 与部署后端一致全部 success=t，替换部署无新增迁移。
- 数据库备份：db-20261113T035313Z.sql.gz（145933 字节 md5=91ccec54…，51 表）；
  **恢复演练 PASS**（临时库整库灌入 exit=0，page_schema=78/meta_model=14/flyway=16 全恢复后清理）。
- 回滚：m15pub-001/002 部署前备份清单齐全（含 designer/runtime 预部署哈希），
  回滚命令与数据库恢复通道已验证可行。
- 前端部署面：designer b3870513…/runtime 0d46a3cc… 与 m15pub-002 deployment.json 一致，
  本轮探针三态复检 unchanged=true。

## 六、过程记录

- 本轮之前的安全/MVP 中间 run（security-final 系列/mvp-final 系列）为套件适配与
  公网种子页修复过程（物料名 Input→TextInput、裸节点→FormItem 包装），不作为台账证据。
- 种子页修复提交 6daa7df（scripts/acceptance/server-seed-accept-data.sh）使公网库
  页面 1 恢复可渲染；修复后本 run 为终验轮。
- 冒烟 12/12（m15-public-smoke-result.json）与本轮互补：冒烟验部署面身份可达性，
  本轮验业务与安全语义。
