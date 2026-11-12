# M12 ER 建模器与影响面交互 — 证据重建终验轮报告（run 20261112-170616-7359cb8）

- 执行时间：2026-11-12 17:06–17:20（UTC+8）
- 源码版本：7359cb872b367e1cc99dd626363ee8c884b52453（HEAD，干净树 workingTreeClean=true）
- 背景：旧证据（legacy/M12-report.md，基线 83b5d33→收口 4b8f374）因 M13-M15 后续提交触碰实现路径
  触发门禁「implementation changed since sourceCommit」连锁失效，且 legacy 形态无 manifest 哈希覆盖、
  台账无 evidence 对象、无独立审查记录——本轮按当前门禁（gateVersion 2）在同一提交全量重跑。
- 验收栈：WSL PG 17（schema_accept 库）+ 本地 18080（受控构建 jar，身份注入）+ 8090 静态代理；
  受控构建 20261112-161930-7359cb8（backendIdentity=true，build-source.txt=7359cb8…）。

## 一、套件结果

| 套件 | 断言 | 结果 | 退出码 |
| --- | --- | --- | --- |
| er-modeler | 49 | 49/49 PASS | 0 |
| er-nine-scenes | 33 | 33/33 PASS | 0 |
| m12-closeout | 18 | 18/18 PASS | 0 |

三套件零 fail、零 skip、零必验缺失，单 run 同源同版。

## 二、覆盖对照（旧报告七域 → 本轮断言）

1. **画布建模**：新建模型、字段增删改（枚举/关联/计算字段配置）、字段唯一键、关系画布全应用关系边
   （九场景⑨：关系边标签 fieldKey·cardinality 呈现、连线创建、删除边落库）。
2. **两段式保存**：precheck→token 签发→confirmValue 校验→token 一次性消费（二次重放被拒）；
   连续保存 v2→v3→v4 落库一致；配置编辑（枚举/关联/计算新增→保存→重开→改→再保存）。
3. **影响面确认**：删除字段弹影响面引用清单；删除确认（未勾选「我已了解」不可提交）；
   高风险确认（错误模型名 confirmValue 阻断）。
4. **409 草稿保护**：浏览器内草稿→外部 API 保存制造真实冲突→UI 保存 409→冲突弹层三方差异→
   无偷偷重发→草稿保留→显式放弃对齐→重编辑保存 v4 落库（closeout A 组 9 断言）。
5. **删除确认**：模型删除两段式（TYPE_MODEL_NAME token 绑定串防挪用）。
6. **版本回滚**：回滚到历史版本、confirmValue=模型名校验、响应 version 字段、
   快照复活口径（回滚不错误复活已删字段）。
7. **权限负例**：普通成员建模 403 PERM_DENIED；跨应用越权 404；token 挪用阻断；无凭证 401。

异步与竞态（closeout B 组）：双击保存幂等（dup_field 落库唯一）、快速切换详情、
B1 冷启动（后端停止→刷新页面错误可见非白屏→后端恢复列表重载画布节点恢复）。

## 三、产物与部署证据

- **产物来源（products.json）**：designer-web/runtime-web/admin-web/accept-backend 四产物，
  全部 sourceCommit=7359cb8…（受控构建 20261112-161930-7359cb8，runtimeVersion 实测登记）。
- **稳定性（stability.json）**：三套件执行完成后四产物哈希逐一实测复检 unchanged=true
  （方法 local-file-sha256-recheck，与 products.json 哈希逐一相等）。
- **部署采样**：
  - er-modeler / er-nine-scenes（全量探针）：runtime-static 前中后三态哈希一致（fca7e184…，
    http-response-sha256）；backend-identity sourceCommit=7359cb8… verifiable=true，
    实例 UUID 前后一致。
  - m12-closeout（静态探针）：B1 场景须重启后端（冷启动负例），为避免 backend-identity
    实例 UUID 变化造成采样误报，closeout 仅采样 runtime-static（前后一致）。
    B1 重启后已恢复完整启动参数，身份复验 verifiable=true sourceCommit=7359cb8…。
- **过程记录**：此前四次中间 run（20261112-162322/163302/164505/165300）为探针适配与
  products 形态修正过程，不作为台账证据；本 run 为终验轮。

## 四、与旧报告的基线差异更新

- 旧备注「自实现卡片＋SVG 画布（非 React Flow）」已过时：2026-11-05 收口（4b8f374）已迁移
  React Flow（Handle 锚点修复 0 边、canvasEpoch 重挂载解决测量竞态、两段式布局持久化）。
  本轮九场景⑨与 er-modeler 全部在 React Flow 画布上实测通过。
- 回滚响应键口径：`version`（非 `currentVersion`）；confirmValue 为模型名。

## 五、已知边界（非阻断）

1. 孤立模型单行横排（无关系时天然同层）——交互优化项，随 M13 排期登记；
2. 409 冲突无三方合并（01BE 口径：放弃或覆盖二选一）；
3. 浏览器实例为本地 CDP 驱动 Chrome（headless 探测 + 真实事件注入），截图存 shots/。

## 六、结论

七域需求全部有当前门禁认可的真实断言覆盖；三套件 100/100 PASS；产物同源同版、
部署稳定、干净树、证据链哈希完整。M12 证据重建完成，可提交独立审查。
