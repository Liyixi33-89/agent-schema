# 详细前端技术文档 09 · 用量埋点 SDK（usage-tracker）

> 上游：《技术方案-前端(React).md》v0.2 §3.11；PRD §8.5（一期只埋不出账）；后端文档 09（事件链路与幂等）
> 本文定位：**实现级技术设计**——事件模型、批量上报、防丢与防伪、合规白名单
> 包：`packages/usage-tracker`（独立包，业务代码只感知 `track()`）

---

## 1. 职责边界

| 负责 | 不负责 |
|---|---|
| 前端采集事件（seat 活跃/AI 发起/自动化触发等漏斗事件） | 计费口径判定（服务端终审，后端文档 09 §4） |
| 批量/防抖/`visibilitychange` flush 的可靠上报 | 事件存储与聚合（metering-service） |
| eventId 幂等键生成与 HMAC 轻签名 | 配额拦截（网关 QuotaFilter） |
| payload 合规白名单校验（采集侧第一道） | 出账/账单展示（Phase 3） |

## 2. 事件模型（与后端 usage_event 对齐）

```ts
type UsageEvent =
  | { type: 'seat.active'; ts: number; userId: string; surface: 'designer'|'runtime' }
  | { type: 'ai.invoke'; ts: number; userId: string; feature: string;
      tokens: { in: number; out: number } }          # tokens 由 AI 网关服务端终审，前端仅漏斗参考
  | { type: 'automation.trigger'; ts: number; flowId: string; trigger: string }
  | { type: 'artifact.load'; ts: number; pageId: string; hash: string };  # 观测：轨道 B 产物加载

统一信封：
interface Envelope {
  eventId: string;        # 客户端 UUID（幂等键，重试复用同一 ID）
  occurredAt: number;     # 客户端事件时间（后端限回溯 24h）
  tenantId?: string;      # 服务端可覆盖，客户端仅透传辅助
  event: UsageEvent;
  signature: string;      # HMAC(密钥, eventId|occurredAt|type)——防伪造轻签名
}
```

## 3. 上报管线

```
track(event)：
  ① 合规校验：payload 深扫描，仅允许 string(id)/number/enum 白名单值
     命中业务字段值（表单值/文件内容/超长字符串）→ 丢弃 + 开发环境抛错
  ② 入队 buffer（容量 100 上限，溢出丢最旧并告警计数）

flush 策略：
  定时 5s || buffer 满 20 条 || visibilitychange(hidden) 立即 sendBeacon
  sendBeacon 失败回退 fetch keepalive；两者都失败 → 保留 buffer 下轮重试（eventId 不变保幂等）

独立通道：POST /api/metering/events
  不经业务网关鉴权/限流链路（计费准确性不受业务限流影响）
  但带 HMAC 签名 + 请求级配额（防刷）
```

## 4. 采集点清单

| 事件 | 采集点 | 说明 |
|---|---|---|
| `seat.active` | 设计器任意**写操作**（保存模型/保存页面/发布/保存脚本） | 仅登录不发；按「用户+自然日」前端去重（省流量，非计费依据——服务端终审） |
| `ai.invoke` | AI 辅助生成面板调用发起/完成 | tokens 以服务端为准，前端值仅漏斗 |
| `automation.trigger` | 运行时按钮触发流程 | 真正执行次数服务端埋（flow.exec），前端仅触发漏斗 |
| `artifact.load` | 轨道 B 产物加载成功/失败 | 观测编译产物健康度 |

去重实现：`seat.active` 用 `localStorage` 键 `seat:{userId}:{yyyyMMdd}` 当日已上报标记（仅前端去重标记，非数据）。

## 5. 防伪与合规

| 风险 | 前端对策 |
|---|---|
| 伪造事件刷/逃计费 | HMAC 签名；**前端事件仅漏斗，计费口径一律服务端**（后端 §4 终审） |
| payload 泄露业务数据 | 深扫描白名单（§3 ①），违规即丢弃 + 遥测告警 |
| 丢数据 | sendBeacon + keepalive + 幂等 eventId 重试 |
| 埋点拖累业务 | 独立通道；同步逻辑仅入队（微秒级）；flush 失败静默退避 |

## 6. 单元测试硬性要求

- [ ] 合规扫描：含对象嵌套业务值的 payload 被丢弃并告警；白名单值正常入队
- [ ] flush 三触发：5s / 满 20 / visibilitychange 均触发且 eventId 不重复生成
- [ ] 幂等：网络失败重试复用原 eventId
- [ ] sendBeacon 降级链路：beacon 失败 → keepalive fetch → 保留重试
- [ ] `seat.active` 前端按日去重：同用户同日多次写操作仅一条
- [ ] 独立通道：埋点请求不带业务网关头（拦截器单测断言）

---

## 附录 · 对接接口清单（消费方视角）

| # | 接口 | 用途 | 来源（后端文档） |
|---|---|---|---|
| 1 | `POST /api/metering/events` | 唯一上报通道：批量信封 `{events:[{eventId, occurredAt, event, signature}]}` ≤100 条；`202` 批量受理；合规失败整批 `422 {invalidIndices[]}` | 09 §A.1 |
| 2 | `GET /api/metering/usage/summary` | 租户用量卡片展示（本 SDK 不消费；admin-console 直连，列出以对齐指标口径） | 09 §A.2 |
| 3 | HMAC 密钥来源 | 运行时配置注入（`/config.json` → 埋点 endpoint 与密钥指纹）；密钥本体不下发前端明文存储——签名密钥由后端按会话签发 | 09 §A.1 / 06FE §7 |

**对接约束**：

- **事件类型对齐**：`seat.active` / `ai.invoke` / `automation.trigger` / `artifact.load` 字段集以后端 `usage_event.metric` 口径表为准（后端 09 §4）——计费指标（seat/flow.exec）以服务端埋点终审，前端值仅漏斗；
- 时间归属：`occurredAt` 客户端时间，服务端限回溯 24h（伪造防护）——前端无需本地校验但重试必须复用原 eventId；
- 升级引导：`QUOTA_EXCEEDED`（429，业务接口返回）由 request-sdk 统一弹层消费（前端文档 07 §4），与本 SDK 无关但同源后端 09 §A.3。
