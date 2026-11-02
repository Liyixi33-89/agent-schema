# M11 应用基础服务与运行时导航工作台 — 实施与验证报告

- 日期：2026-11-02
- 基线提交：`5195282`（feat(M11): 应用基础服务与运行时导航工作台）
- 验收任务：workflow.json `M11`（依赖组 `M2-M5` / `M6-M7` 前置证据复核见 §5）

## 1. 范围与缺口判定

原始骨架（会话前态）仅有 app-module 领域模型/仓储接口 + V13 迁移草稿，存在编译缺陷且未接入 bootstrap。
本次交付将 M11 验收项全部闭合：

| 验收项 | 交付内容 | 位置 |
| --- | --- | --- |
| 应用创建、列表、详情、修改、归档、删除确认；权限校验、配额限制及必要审计 | `AppService`（CRUD/归档恢复/删除影响面/配额 50/重名校验）+ `AppController` REST | app-module |
| 应用成员：查询、添加、角色修改、移除；复用 IAM 角色及席位机制 | `AppRoleService`（默认三角色初始化、创建者自动管理员、席位守卫复用、最后管理员保护）+ 成员端点 | iam-module（切口）+ AppController 转发 |
| 导航树结构校验、页面归属校验、版本并发冲突 | `AppService.saveNav`（结构校验 type/label/children 深度≤3/节点≤200；PAGE 归属强校验）+ `NavVersionConflictException` → 409 | app-module |
| 对接已有应用发布快照与发布记录 | 复用 V4 `app_release` / `page_release_version`（04BE §1.2）；**未重复建表**——骨架期 V13 草稿中的 `app_release_ptr` 已删除 | V13 注释声明 |
| 运行时容器：应用导航壳、页面路由、鉴权守卫、权限过滤菜单 | `AppShell.tsx`（`#/app/:appId` 服务端过滤菜单 + 页面路由）| apps/runtime |
| Schema 拉取与 ETag/304 缓存、租户切换清缓存 | `FormPageHost` ETag 缓存（304 命中用缓存 schema 渲染）+ localStorage 按租户键隔离 + `watchTenantChange` 清理 | apps/runtime |
| 保持预览凭证隔离 | 裸页面路由 `#/page/:pageId` 保持原通道不变 | apps/runtime/main.tsx |
| 设计器工作台：应用卡片墙、搜索及应用操作；应用设置四页签 | `designer/src/main.tsx`（卡片墙 + 成员/导航/主题/发布四页签） | apps/designer |
| 管理端 P1：租户用量、成员管理、健康状态、维护公告页面及对应接口 | `OpsController`（健康 + 公告，org:manage 闸门）+ admin-console 四页 | app-module + apps/admin-console |
| 测试与验收 | `AppServiceIT` 13 用例 + 全量 IT 门禁 | bootstrap/src/test |

## 2. 架构决策（复用优先）

1. **成员/角色复用 IAM**（避免另建不兼容角色体系）：骨架期草稿 `app_member` 表已删除；
   成员 = `sys_role(role_type='APP', app_id)` + `sys_user_role`（V3 已有表）；授权走
   `iam.replaceUserRoles` 席位守卫通道（`SeatGrantGuard` SPI）；设计能力席位判定口径
   `app_admin/developer` 与既有计量口径一致（09BE）。
2. **发布记录复用 V4**：应用发布快照与发布记录由 page-module `ReleaseController` 承载
   （`/api/apps/{id}/releases`、`/api/apps/{id}/publish` 已存在于基线）；M11 仅消费不重建。
3. **权限过滤菜单服务端为准**（13BE §3.3）：`GET /api/apps/{id}/nav?filtered=true`
   经 `PageRefAdapter.filterNavTree` 按用户角色过滤（无权限整枝剪除），前端不做二次判断。
4. **页面切口接口反转**：`AppPageRef` 定义在 app-module、实现在 page-module
   （依赖方向 page→app，避免循环）；bootstrap 组合根装配。

## 3. 已修复的骨架缺陷

| 缺陷 | 修复 |
| --- | --- |
| `parseStringList` 未定义（编译错误） | 领域层重构后不再需要；仓储直接 JSON 字符串透传（`?::jsonb`） |
| `Json.writeStringList` 不存在 | 移除（成员逻辑迁至 IAM 后无此调用） |
| JSONB 参数绑定（String → jsonb 列 BadSqlGrammar） | 项目惯例 `?::jsonb` 显式转换（insert/update 三处） |
| 可空列 `icon_file_id`/`created_by` 读取（`getLong` null→0） | `getObject` + null 判定 |
| `updateProfile` 图标参数 String/Long 类型不一致 | 统一 Long |
| V13 与 V4 发布表重复、与 V3 角色表重复 | 删除 `app_release_ptr`/`app_member`，V13 仅留 `app` + `ops_notice` |

## 4. 验证证据

### 4.1 后端编译与测试（WSL 内 PG 16，真实数据库）

```
mvn -pl bootstrap -am '-Dtest=AppServiceIT' test
→ Tests run: 13, Failures: 0, Errors: 0, Skipped: 0  (AppServiceIT)

全量 IT 门禁（verify.ps1 backend-it 清单 + AppServiceIT）：
mvn -pl bootstrap -am '-Dtest=MetadataCommandServiceIT,IamServiceIT,IamSecurityChainIT,PageServiceIT,PageSecurityChainIT,MeteringIT,FileServiceIT,NotificationIT,ObjectStorageContractIT,AppServiceIT' test
→ 112 tests, 0 failures, 0 errors — BUILD SUCCESS
```

AppServiceIT 覆盖的硬性验收场景：

- 跨租户访问：租户 2 用户读租户 1 应用 → `APP_NOT_FOUND`（404，同判不存在）
- 越权拦截：无成员关系用户不在工作台卡片墙出现（服务端过滤）
- 导航并发：过期 `baseVersion` 提交 → `NavVersionConflictException`（接口层 409 NAV_VERSION_CONFLICT）
- 导航校验：PAGE 归属强校验（`NAV_PAGE_NOT_FOUND` 422）、非法 type/空 GROUP/缺 url → VALIDATION_FAILED
- 最后管理员保护：移除唯一 `app_admin` → `APP_ADMIN_REQUIRED`（409）
- 跨租户成员：添加租户外用户 → `USER_NOT_FOUND`；未知角色 → `ROLE_NOT_FOUND`
- 创建链路：默认三角色就位 + 创建者自动 `app_admin` + 审计落库
- 归档生命周期：ARCHIVED 不可编辑导航（`APP_NOT_EDITABLE`）、恢复后可编辑
- 配额与重名：`APP_NAME_DUPLICATED`（422）、配额上限 `APP_LIMIT_EXCEEDED`（403）——配额阈值见服务常量

### 4.2 前端构建与测试

```
pnpm exec turbo run build '--filter=@schema/designer' '--filter=@schema/runtime' '--filter=@schema/admin-console'
→ 3 apps build success（schema-form/schema-renderer 等依赖包 cache hit）

pnpm exec vitest run
→ 121 tests passed（含架构守卫：跨包协议导入拒绝）
```

### 4.3 验证管线

- `verify.ps1 quick`：doc-anti-corruption / frontend-tsc / frontend-build / backend-compile / contract-diff 全 PASS
- `verify.ps1 commit`：backend-it 探活 FAIL 为本机 Windows→WSL 网络半失效既知误报
  （集成测试本体已在 WSL 内全绿，见 §4.1；CI Linux/pwsh 环境无此问题——与 M8-M10 验收时同口径）

## 5. 依赖组前置证据复核（M2-M5 / M6-M7 解锁）

M11 台账依赖 M2-M5 与 M6-M7 两组（均为 implemented 待验收）。本次全量回归覆盖两组的验收测试：

- **M2-M5（后端核心闭环）**：`DataEngineIT`（11）+ `DataEngineSecurityIT`（20）+
  `WriteConstraintsIT`（7）= 38 tests 全绿（2026-11-02 复跑，WSL PG）；
  元数据域 `MetadataCommandServiceIT` 在全量门禁中同步全绿。
- **M6-M7（渲染引擎 + 表单内核）**：前端 vitest 121 tests 全绿（含 schema-renderer 指令流、
  schema-form 五修复回归、架构守卫）；runtime 最小宿主（FormPageHost）构建通过。

两组的详细验收证据与独立审查意见随本轮 accept 一并登记（见 workflow.json 对应任务字段）。

## 6. 已知边界与分期决策（非缺口）

- 导航编辑器为列表式（上移/下移/删除；GROUP 子节点经树形展示只读）——拖拽式编辑器随设计器后续迭代；
- `OpsController` 健康检查为轻量自实现（DB 探活 + 版本），不引 actuator（依赖最小化）；
- admin-console 租户清单/档位调整/模板管理未实现（13BE §6 P2 范围，分期决策）；
- 应用删除为归档式（DELETING + deleted_at），物理清理任务随 M12+；
- 运行时菜单权限过滤对「完全未配置页面权限行」的应用成员默认全可见（运行时读取面无功能闸口径，
  PagePermGate 注释同构）；已配置行权限的页面按行精确过滤（默认拒绝）。
