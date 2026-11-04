# M12 验收报告（2026-11-04 · 基线 83b5d33 → 收口 ee4a356/53cdebd）

## 一、验收范围与结论

| 项 | 结果 | 说明 |
| --- | --- | --- |
| er-modeler 主链路 | 48/48 PASS | 浏览器 UI（CDP 真实事件）+ API 断言 + DB 落库核对；fail-fast |
| designer 回归 | 37/37 PASS | 成员/导航/主题/发布 + 越权负例（适配「模型」新页签） |
| runtime 回归 | 23/23 PASS | 真实鼠标提交→POST→DB 精确核对→登出失效 |
| admin 回归 | 23/23 PASS | 成员/用量/健康/公告 + 越权 + 跨租户 |
| cache 回归 | 23/23 PASS | 预览/正式缓存隔离、租户切换菜单重载 |
| verify[commit] | 七步 PASS | doc-anti-corruption/frontend-tsc/backend-compile/contract-diff/frontend-build/frontend-test/backend-test/backend-it |
| 后端集成测试 | 18/18 PASS | MetadataCommandServiceIT（含新增跨应用越权回归） |
| 协议包单测 | 26/26 PASS | save-flow.test.ts（两段式状态机/布局/关系边/草稿 diff/重名判定） |

## 二、P0 安全收口（本轮修复）

1. **编译阻塞**：ModelController 内联 `DesignGate` 声明移除（独立接口 + bootstrap `DesignGateConfig` 装配）。
2. **普通成员越权建模**：`DesignGate.requireDesignCapability`（developer/app_admin/org:manage 三口径）接入模型全链 11 端点；`GlobalExceptionHandler` 补 `PERM_DENIED→403` 映射（DesignGate 从 metadata 包抛出，IAM 域 advice 不接力——此前 400）。浏览器验收实证：普通成员建模/precheck 均 403。
3. **跨应用越权**（应用 A 设计者携 A 的头操作应用 B 的模型）：`loadForTenant` 应用域绑定——`model.appId() != tenant.appId()` 同判 404（不给跨应用存在性线索，与 page 域 `assertAppConsistent` 同构）。覆盖读/precheck/save/rollback 全链。回归测试 `crossAppAccessRejectedEvenWithDesignCapabilityInOwnApp` 入 MetadataCommandServiceIT。

## 三、P1 功能完整性（本轮修复）

| 缺口 | 修复 |
| --- | --- |
| 保存后详情缓存不刷新 | `refreshDetail` 抽出；保存/回滚/409 后强制重拉（懒加载版本号不再停留旧态） |
| 放弃修改不还原草稿 | 按服务端态重建详情草稿（本地编辑不残留） |
| 新增后再删除误发 DELETE_FIELD | `buildDraftChanges` 下沉协议包：本地新增+删除 → 抵消；服务端 DELETED 再删 → 幂等无操作 |
| 字段重名前置校验缺失 | `isDuplicateFieldKey` 本地阻断（服务端 FIELD_KEY_DUPLICATED 兜底） |
| enum/relation/computed 无编辑入口 | 类型相关配置表单（enumOptions 每行 value\|label 校验/relation 目标+基数+级联/computed 表达式+依赖+持久化），修改回填 |
| 删除确认 every([]) 恒真漏洞 | 含删除且无 HIGH 影响面时须显式勾选删除确认（DELETE_ACK_IDX） |
| 回滚预检风险未展示 | 预检影响面先呈现（风险列表/无风险说明），用户输入模型名后确认提交 |
| runRollback 状态竞态 | 预检改显式传参（setState 异步致闭包读旧值——预检静默不发） |

## 四、已知边界（登记不阻塞）

- **基线偏离**：画布为自实现卡片 + SVG 关系边 + 网格布局（非 React Flow + 分层自动布局）。关系边提取 `extractRelationEdges` 与网格布局 `gridLayout` 已单测覆盖；交互降级待产品确认（拖拽自由布局/关系创建入口随 M13 页面设计器统一评估）。
- **关系画布**：关系边仅来自已加载详情的模型（懒加载权衡——全量拉取曾致浏览器 6 连接占满写请求排队超时）。
- **409 冲突**：刷新详情+提示重做（无三方合并）——草稿保护走「放弃修改重建」，与 01BE §4.2 口径一致。

## 五、验证命令

```bash
node scripts/acceptance/accept-er-modeler.cjs   # 48/48 PASS
node scripts/acceptance/accept-designer.cjs     # 37/37 PASS
node scripts/acceptance/accept-runtime.cjs      # 23/23 PASS
node scripts/acceptance/accept-admin.cjs        # 23/23 PASS
node scripts/acceptance/accept-cache.cjs        # 23/23 PASS
powershell -File scripts/verify.ps1 commit      # 七步 PASS
```

环境：WSL PG schema_accept 库 + 后端 18080 + Node 静态代理 8090（Chrome CDP headless，每轮独立 profile）。

## 六、提交

- `ee4a356` feat(designer): M12 ER 建模器前端收口——缓存一致性/配置补全/确认交互
- `53cdebd` fix(metadata): M12 建模授权与跨应用越权收口
