# 独立审查：FIX-M8 / FIX-M9 / FIX-M10 验收证据

- 审查对象：FIX-M8（计量认证/可靠队列/席位并发）、FIX-M9（文件凭证/完整性）、FIX-M10（通知抑制/频控）
- 审查基线提交：`856987fbbc30fc08edceb45f5c3fd47fd5c20998`
- 证据报告：`.agent/evidence/FIX-M8M9M10-it-report.txt`
- 审查日期：2026-11-02
- 审查者：`independent-reviewer`（非实现者，依据代码与测试产物独立核对）

## 1. 审查方法

依据《evidence-driven workflow》（.agent/workflow.md）第 3-6 条：evidence 必须对应当前 HEAD、报告须真实反映执行结果、需求覆盖须逐项核对代码与测试。本次审查独立核对以下四点：
1. 各验收项是否有对应测试代码且确实执行；
2. 测试是否覆盖验收项声称的行为（含负例/边界）；
3. 证据报告的提交号、命令、结果与 HEAD 是否一致；
4. 是否存在未提交代码影响证据有效性。

## 2. 逐项核对

### FIX-M9

| 验收项 | 覆盖代码 | 判定 |
|---|---|---|
| http-multipart：真实 HTTP 多块上传并 complete；校验会话、块号、过期、PUT/GET 方法绑定 | `FileServiceIT`：`真实凭证链路_PUT消费后重放拒绝_GET凭证不得用于PUT`（PUT 消费、重放拒绝、GET/PUT 隔离）、`真实凭证链路_过期凭证被拒`（TTL 过期）、`分片真实链路_完整上传合并与ETag校验`（4 块 25MB、独立 PART 凭证、错误 etag 负例 UPLOAD_MISMATCH、合并后大小核对） | ✅ 覆盖 |
| content-integrity：SHA-256、魔数、ETag 不匹配全部拒绝；测试只清自建记录 | `FileServiceIT`：`完整内容校验_伪造摘要与类型伪装被拒`（伪造 SHA-256 负例 UPLOAD_MISMATCH + 对象清理断言、声明 PDF 实际 PNG 魔数拒绝、真实 PDF+正确摘要通过）、`对象Key规范_路径穿越被清洗`、`存储抽象_魔数探测`；测试清理按 `ownFileIds` 精准删除（`FileServiceIT.cleanup`），无跨租户猜测式清理 | 覆盖 |

### FIX-M8

| 验收项 | 覆盖代码 | 判定 |
|---|---|---|
| authenticated-retry：认证注入真实生效；beacon 不以排队成功当受理；持久化重试不丢幂等键 | 前端 `usage-tracker` `index.ts`/`test/tracker.test.ts`：sendBeacon 失败保留 buffer 回退 fetch、flush 真实调用 authHeader、幂等键保留；`MeteringIT` 覆盖服务端幂等（`幂等_同eventId重投递只计一次`）与 source 强制（`防伪造_客户端通道终审指标被拒`、`防伪造_source客户端声明不作数`） | 覆盖 |
| seat-concurrency：并发授权/撤销不突破配额；跨应用不超额；成员事件即时重算 | `MeteringIT`：`席位限流_超限授权被拒且角色不落库`（SEAT_LIMIT_EXCEEDED + 拒绝后无残留）、`席位并发_多线程同时授权不突破上限`（5 线程并发、配额 2、精确 2 通过）、`成员变更_授权后即时快照重算`、`快照兜底_角色全部撤销租户写零值`；`MeteringSchedule` 调度逻辑存在 | 覆盖 |

### FIX-M10

| 验收项 | 覆盖代码 | 判定 |
|---|---|---|
| suppression：SUPPRESSED 不进入列表/未读数，审计可追溯 | `NotificationIT`：`FIX_M10_抑制消息不进列表与未读数`（列表/total/unread 排除、markAllRead/markRead 不触碰、`suppress_reason=USER_PREF_DISABLED` 落库）、`偏好_业务类型关闭后SUPPRESS`、`状态机_单条已读幂等` | 覆盖 |
| tenant-rate：跨 bizRef 不绕过用户上限；收件人隔离；安全告警豁免 | `NotificationIT`：`FIX_M10_跨bizRef不绕过用户级上限`（60 键、50 通过 + 10 USER_LIMITED）、`FIX_M10_租户级护栏跨bizType跨用户合计`（TENANT_LIMITED + SECURITY_ALERT 豁免）、`越权_同租户他人消息不可标记已读`（收件人绑定）、`越权_跨租户消息不可见` | 覆盖 |

## 3. 证据有效性结论

- **提交号**：六条 evidence 的 `commit` 全部等于当前 HEAD `856987f...`，与 `git rev-parse HEAD` 一致。
- **报告真实性**：`FIX-M8M9M10-it-report.txt` 记录三条集成测试（MeteringIT 14 / FileServiceIT 14 / NotificationIT 12，合计 40），BUILD SUCCESS，执行时刻 2026-11-02 09:44:24。命令与报告一致。
- **代码一致性**：三个模块（metering/file/notification）最新提交分别为 `08f738f`/`976c861`/`f9d9297`，均早于 HEAD，HEAD 仅含 workflow 元数据变更，不存在"旧测试用于新代码"问题。

## 4. 遗留说明（非阻塞）

1. **并发测试为线程级而非跨进程/DB 压力**：`席位并发_多线程`用线程池 + TransactionTemplate 验证，属集成级合理验证，但真实并发写入的最终保障仍需在 M8-M10 完整验收的压测环节复核。
2. **前端 beacon 认证为单测覆盖**：`usage-tracker` 测试验证了 authHeader 注入与失败保留，未在真实浏览器网络层回放；浏览器级回归建议并入 M8-M10 完整验收。
3. **测试数据隔离**：FileServiceIT 按自建 `ownFileIds` 清理、MeteringIT 按租户 881/883 清理，符合自建自清原则，未见跨租户污染。

## 5. 审查结论

批准 FIX-M8、FIX-M9、FIX-M10 三条 evidence 通过。审查意见：三项验收项均有对应测试代码覆盖正/负例，证据提交号与 HEAD 一致，报告真实，未见阻塞项。可推进至 `accepted`（实现侧）。

> 本审查仅覆盖 FIX 任务自身的验收证据。M8-M10 作为依赖组的**完整验收**（metering.raw、MinIO 契约、通知业务事件接线等）仍在 M8-M10 任务范围内，不因本次 FIX 通过而豁免。