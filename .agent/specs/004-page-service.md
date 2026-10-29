---
spec_id: 004-page-service
status: active
milestone: M4                # 依赖图 §3.4 页面服务（前置：M1.4/M2.4/M3.2）
created: 2026-10-29
---

# spec-004 · 页面服务（page-service）

> 真源：详细技术文档 04《页面服务与编译服务》§1/§A.1/§A.2/§A.4/§A.6/§A.7
> 交付范围：M4.1 存储 / M4.2 发布快照+ETag / M4.3 字段引用登记 / M4.4 预览凭证。build-service（轨道 B）在 M14 分期交付。

## 1. 任务清单

| # | 任务 | 出处 | 状态 |
|---|------|------|------|
| T1 | V4 DDL：page_schema / page_release_version / app_release / page_preview_grant / page_preview_session | 04BE §1.2 | done |
| T2 | PageAggregate + PageRepository（草稿乐观锁/发布条件更新/逻辑删除） | 04BE §1.1 | done |
| T3 | 发布链路：draft→published 拷贝 + 页面版本不可变固化 + 应用快照聚合 | 04BE §1.3 | done |
| T4 | 回滚：按历史 release 从 page_release_version 取全量快照回写（自包含，不依赖 draft） | 04BE §1.3 | done |
| T5 | 运行时读取 ETag（If-None-Match → 304） | 04BE §A.4 | done |
| T6 | FieldRefScanner 五位置扫描（fieldRef/dependsOn/filter/aggregate/scripts 静态正则） | 04BE §1.4 | done |
| T7 | 引用登记接线：saveDraft/publish 全量重扫 upsert；deletePage 全清（进程内适配器 → MetadataCommandService） | 04BE §1.4 / 01BE §A.4 | done |
| T8 | 预览凭证：grant 5min 单次（条件 UPDATE 一次性消费）→ exchange 15min 会话 → 吊销闭环 | 04BE §A.7 | done |
| T9 | JwtCodec.issuePreview（typ=preview + previewSessionId claim）+ JwtAuthFilter 预览态会话校验 | 04BE §A.7 | done |
| T10 | REST 三控制器 + PageExceptionHandler（包限定，域错误码→HTTP 映射） | 04BE §A.1/A.2/A.7 | done |

## 2. 验收记录（04BE §4 硬性要求）

- [x] **发布后运行时返回新版 ETag；未发布 draft 不影响 published** —— PageServiceIT.publishProducesEtagAndDraftDoesNotLeak
- [x] **回滚产生新发布版本，快照自包含（删除 draft 后仍可回滚恢复）** —— PageServiceIT.rollbackRestoresImmutableSnapshot（回滚恢复 v1 时刻空布局，被回滚 release 不可再作目标）
- [x] **五位置引用扫描进 meta_field_reference（PAGE/SCRIPT 两类）** —— PageServiceIT.fieldReferencesRegisteredOnSaveAndPublish + scannerExtractsAllFivePositions（`__count` 伪字段跳过）
- [x] **预览凭证 grant→exchange→吊销全链（重放 401 GRANT_CONSUMED；吊销后下一请求 401 PREVIEW_SESSION_REVOKED）** —— PageServiceIT.previewGrantLifecycle
- [x] 草稿乐观锁 409 / 路径租户内唯一 422 / 跨租户同判 404 —— PageServiceIT 其余三用例
- [x] backend-it 门禁纳入 PageServiceIT（verify.ps1 backend-it 步骤）

## 3. 设计决策与妥协

- **进程内上下文映射**：MetadataFieldReferenceAdapter 直连 MetadataCommandService（单体阶段禁跨模块 join 但允许应用服务消费——bootstrap 组合根背书）；拆分后换 RPC，domain 端口 FieldReferencePort 不变。
- **引用登记失败不阻断保存/发布**（04BE §1.4 重试队列口径的 MVP 简化）：syncFieldReferences catch-all，影响面数据允许短暂滞后。
- **sort 字段入引用面**：04BE §1.4 未列但排序字段被删同样致页面故障——影响面口径宁全勿漏。
- **本地无 Redis**：grant/会话以库表落地（条件 UPDATE 一次性消费语义等价，防 TOCTOU），Redis 化随 M5。
- **exchange 为公开端点**：grant 本身即凭证（短时单次），兑换不叠加登录态；跨租户 grant 同文案 GRANT_CONSUMED（不给存在性线索）。
- **预览权限闸门**：MVP 落地为持 `action:org:manage` 或 `action:preview:grant` 权限点（角色实时判定，逐请求）。
- **回滚也生成新 release**（status=ACTIVE），目标版本置 ROLLED_BACK 不可再次回滚（防回滚链成环）。

## 4. 延后项登记

- Outbox 化引用登记（当前 catch-all 静默）→ 随 M5 事件基建。
- 预览会话 Redis 化（当前库表）+ allowRealWrite 数据面执行拦截（写操作代理判定）→ M5/M6。
- artifact_hash 产物链路（轨道 B 自定义代码编译）→ build-service M14。
- 页面 Schema 完整结构校验（当前信任前端导出契约，PageSchema zod 镜像未落 Java）→ 随 M6 渲染消费方。
- 发布快照 modelRefs 聚合（当前空数组占位）→ M5 模型引用快照落地后补。

## 5. 沉淀（2026-10-29）

- **BizException.notFound 硬编码 MODEL_NOT_FOUND 的跨域陷阱**：page 域复用时错误码错域（测试断言 PAGE_NOT_FOUND 实得 MODEL_NOT_FOUND）——域特定 notFound 必须独立工厂方法（新增 pageNotFound），公共工厂只留给本域。
- **聚合查询空集 NPE**：`jdbc.query(...).stream().findFirst()` 对 SELECT MAX 空集行返回 NULL 值时会 Optional.of(NPE)——聚合列永远有行但值可 NULL，RowMapper 里 `instanceof Number` 兜 0 而非返回 null。
- **吊销语义与测试顺序**：revokeAll 语义是「未用 grant 全部作废」——测试若先 revokeAll 再 exchange 未用 grant，正确断言是 GRANT_CONSUMED 而非成功兑换；生命周期测试的操作顺序必须与语义图一致，不能按直觉排列。
- **PER_CLASS 测试的种子数据漂移**：依赖其他 IT 种下的用户/角色 ID（user_id=1）会在库重置后失效——测试自建专用操作者（固定 account 幂等查找），不依赖兄弟测试的副作用。
- **PS 管道下 mvn Exit code 1 误报（再现）**：看 `BUILD SUCCESS` 与 `Tests run: ... Failures: 0` 为准。
