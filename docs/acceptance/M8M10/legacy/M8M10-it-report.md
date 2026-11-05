# M8-M10 依赖组完整验收证据（计量 / 文件 / 通知）

- 任务：M8-M10 计量文件通知依赖图完整验收
- 验收基线：HEAD ec4f112（FIX-M8/M9/M10 已 accepted）
- 验收日期：2026-11-02
- 覆盖：M8（计量埋点采集）/ M9（文件服务）/ M10（通知服务）依赖图完整验收项

## 验收结论：通过（补齐 2 处依赖组缺口）

审查结论（review-M8M9M10 第 5 条）指出：FIX-M8/M9/M10 只修缺陷，**依赖组完整验收（metering.raw、MinIO 契约、通知业务事件接线）仍在 M8-M10 范围内**。本轮补齐并验证：

### 1. 计量 M8.2——登录事件埋点接线（新增实现）

依赖图 M8.2 明确要求「登录/建模/发布/席位事件 → metering.raw」。此前建模✓/发布✓/席位✓，**登录事件未接线**。

- `platform-common` 新增 `LoginSucceededEvent(tenantId, userId)`（发布方零依赖 metering，Spring 事件解耦）
- `iam-module AuthService.login` 登录成功路径发布事件（事务内，`loginSucceeded` 之后、审计之前）
- `metering-module` 新增 `LoginMeteringListener`：监听 → `recordServer(tenantId, userId, "seat.active", 1, surface=login)`，服务端终审口径（09BE §4 防伪造红线）

**测试**（MeteringIT 新增 `登录埋点_登录成功记seat_active服务端终审`）：bcrypt 造真实用户 → `auth.login` 走完整事件链路 → 断言 `usage_event` 落 `metric=seat.active, source=SERVER, surface=login`，并参与 `rollingActiveSeats` 活跃口径。

### 2. 文件 M9.1——ObjectStorage 契约测试（新增测试）

依赖图 M9.1 明确要求「ObjectStorage 接口 + MinIO/LocalFs 双实现 + **契约测试**」。此前有接口+LocalFs 实现，但**缺契约测试**（FileServiceIT 只直测 LocalFs 具体类，用 Op/TokenBinding 等实现特有 API）。

- 新增 `ObjectStorageContractIT`：**仅通过 `ObjectStorage` 接口**验证存储行为契约——
  - write/read/head/delete 往返一致（含字节数校验）
  - write 覆盖重写语义
  - presignPut/presignGet 签发（expiry 原样返回）
  - 分块会话完整生命周期（initiateMultipart → presignPartPut → writePart → partSha256 → complete/mergeParts，合并字节数校验）
  - 分块缺失合并抛异常
  - 路径穿越（`../` 前缀）读写拒绝
- **同套契约落点**：S3StorageImpl（MinIO/OSS 同协议）未来接入时复用本套测试即可验证契约一致；运行时注入 LocalFsStorage（本地零依赖实现），契约与实现解耦。

### 3. 通知 M10——业务事件接线（分期决策确认）

依赖图 M10.1/M10.2（notify_message 模型✓/站内信通道✓/未读数✓/模板引擎✓/频控✓）均已覆盖。**业务事件接线点 = `NotificationService.send` 公开服务方法**；MVP 只交付站内信通道，审批待办由流程引擎（Phase 2）调用 `send`——已登记的分期决策（依赖图 §3.10），`send` 接口即接线契约，NotificationIT 已覆盖完整管线（偏好过滤/频控 SUPPRESS/模板/频道/已读状态机/越权隔离）。**无需补实现。**

## 测试证据

- `ObjectStorageContractIT`：7 tests，0 failure，0 error
- `MeteringIT`（含新增登录埋点）：15 tests，0 failure，0 error
- 完整集成测试门禁（含新增契约测试）：**143 tests, 0 errors, 0 failures, 0 skipped**（WSL 内 PG 执行）
- verify[commit]：doc-anti-corruption / frontend-build / frontend-test / backend-test 全 PASS；backend-it 在本机 Windows 侧探活 127.0.0.1:5432 探不到 WSL PG（Windows→WSL 网络半失效环境妥协），集成测试本体已在 WSL 内全绿

## 改动文件

新增：
- `platform-common/.../event/LoginSucceededEvent.java`
- `metering-module/.../application/LoginMeteringListener.java`
- `bootstrap/.../test/.../ObjectStorageContractIT.java`

修改：
- `iam-module/.../application/AuthService.java`（注入事件发布器 + 登录成功发布）
- `bootstrap/.../test/.../MeteringIT.java`（新增登录埋点测试）
- `scripts/verify.ps1`（契约测试加入 backend-it 门禁）