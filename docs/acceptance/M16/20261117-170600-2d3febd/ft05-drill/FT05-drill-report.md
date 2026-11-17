# TC-FT-05 告警触达演练报告（三合一：注入→告警→触达→大盘对照·2026-11-17）

> 定位：闭环 `TC-coverage-matrix.md` TC-FT-05（NOT-RUN 上线阻断项）与 TC-FT-06（PARTIAL 大盘对照位）。
> 环境：压测栈 18083 / PG 15433（隔离，不碰生产 18080/18081 与 5432）。
> 执行：`ft05-drill.sh`；接收端：`ft05-webhook-recv.py`（本机自建 webhook 接收端 127.0.0.1:18098）。

## 1. 告警通道说明（诚实边界）

**通道形态**：服务器自建 HTTP webhook 接收端（python3 标准库，无第三方依赖）。
- **真实链路部分**：脚本侧 `send_alert` → 真实 HTTP POST（Content-Type: application/json）→ 接收端落盘 inbox.jsonl（含服务器接收时刻）→ 响应钉钉/企微兼容契约 `{"errcode":0}`。发送/接收同机时钟，触达时延为真实测量值。
- **未覆盖部分（如实声明）**：第三方 IM/短信/电话的「推送服务→值班人员手机」段不在本轮验证范围——用户未提供第三方凭据。自建接收端契约与钉钉/企微 webhook 兼容（POST JSON + `{"errcode":0}` 响应），切换真实 IM 仅需改 `SCHEMA_ALERT_WEBHOOK`/`ALERT_WEBHOOK` URL 为第三方地址，发送逻辑无需改动。
- **值班触达语义**：本轮「触达」= 告警消息到达接收端并落盘可查。上线前若接入第三方 IM，建议补一次「真实 IM 收到消息」的人工确认截图（5 分钟内）。

## 2. 演练结果（第二轮修复后 PASS，第一轮产物保留）

| 项 | 结果 | 明细 |
|---|---|---|
| 告警发送 | 3/3（P1/P2/P0 各 1） | 三场景注入均触发对应级别告警 |
| 接收端触达 | **3/3 delivered** | inbox 计数 0→3 精确匹配；接收响应 `{"errcode":0}` |
| 触达时延 | **10.3 / 11.6 / 10.4 ms**（P1/P2/P0） | 目标 <5min（spec TC-FT-05），**余量 ~30000 倍** |
| 分级语义 | P0/P1/P2 级别字段随告警传递 | payload.level 与演练场景一一对应 |
| 业务不雪崩 | ft01 池耗尽期间查询 200；ft02 单行锁期间其他行查询 200 | 与前轮 TC-FT-01/02 结论一致（复测） |
| kill -9 RTO | 9s（业务探活 200） | 与前轮 10s 量级一致（复测） |
| 大盘对照（TC-FT-06 位） | 注入期间 opsHealth 401（鉴权拒绝=服务存活语义）；演练后 ops 端点回归 401（数据面未损坏） | 健康页四聚合接口挂鉴权，注入期间探活以「任意响应=活」口径（与前轮 fault-drill 一致） |

**判定：TC-FT-05 PASS（自建通道语义）/ TC-FT-06 大盘对照位补齐（注入期间存活语义 + 演练后回归）**。
第三方 IM/短信触达段维持「未验证」声明（§1 诚实边界），不因自建通道 PASS 而宣称「值班手机已收到」。

## 3. 第一轮 FAIL 说明（脚本缺陷，产物保留）

首轮 `delivery=FAIL` 为脚本自身缺陷：inbox 路径写成 `$STAGE/ft05-webhook-inbox.jsonl`，而接收端实际写 `/opt/schema/staging/fault-drill/ft05-webhook-inbox.jsonl`（两级路径不一致），且冒烟 TEST 记录混入判定（inbox 1→4，expect 4 把冒烟记录当成第 4 条）。**告警实际已 3/3 触达**（首轮 delivery.json 逐条 delivered=true 可证）。修复：INBOX 改为接收端真源路径 + 演练前清零。两轮时间线均在 `ft05-timeline.jsonl`（首轮 06:20 段、二轮 06:22 段），首轮不删除——脚本缺陷修复过程可追溯。

## 4. 产物清单

- `ft05-result.json`——汇总判定（PASS）
- `ft05-delivery.json`——逐条触达明细（级别/文本/发送时刻/接收时刻/时延/判定）
- `ft05-timeline.jsonl`——完整演练时间线（两轮）
- `ft05-webhook-inbox.jsonl`——接收端落盘原始记录
- 脚本入库：`scripts/acceptance/m16-relaunch/ft05-drill.sh` + `ft05-webhook-recv.py`
- 服务器部署位：`/opt/schema/staging/`（接收端进程持续存活，可复用）

## 5. 遗留与建议

1. **第三方 IM 凭据**：用户提供钉钉/企微 webhook URL 或短信网关凭据后，仅改 URL 即可复测「真实 IM 触达」段；脚本无需改动。
2. **告警源接线**：本轮验证的是「演练脚本→接收端」通道。生产告警源（schema-backup.sh 的 `SCHEMA_ALERT_WEBHOOK`、fault-drill 的 `ALERT_WEBHOOK`）已支持同契约——写入 `/etc/schema-platform.env` 即生效（本轮未改线上 env，维持「演练不碰生产」铁律）。
3. **P0 电话/短信通道**：spec 要求「P0 电话/短信+IM」——电话/短信段依赖第三方凭据，维持上线前待接入声明；当前自建通道覆盖 IM 语义。
