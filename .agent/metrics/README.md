# metrics — 度量闭环

> 度量数据**不入 git**（`verify-log.jsonl` 已 gitignore）；本文件只固化口径，不记录数值。

## 采集口径

每次 `scripts/verify.ps1` 运行自动追加一行 JSON 到 `verify-log.jsonl`：

```json
{ "ts": "ISO8601", "level": "quick|commit|ci", "result": "PASS|FAIL|SKIP", "duration_ms": 123, "failed_step": null, "trigger": "manual|agent|ci" }
```

## 团队级指标（从流水聚合，季度复盘）

| 指标 | 口径 | 用途 |
| --- | --- | --- |
| 验证通过率 | PASS / (PASS+FAIL)，按 level 分层 | 体系健康度；quick 层持续 <80% 说明约束写得不可执行 |
| 静默重试率 | FAIL 后 2 次内未换思路的比例（Agent 自报） | 烧 token 预警；AGENTS.md §8 红线执行情况 |
| 返工率 | 同一 spec 内 FAIL→修复→再 FAIL 的循环次数 | 高返工点 = skill 缺失信号，触发沉淀 |
| skill 命中 | CR/返工原因匹配到已有 skill 的比例 | 沉淀覆盖率；未命中且可复用的当场新增 |
| spec 结项及时性 | done 回填延迟 | 文档防腐执行情况 |

## 红线

- 度量只用于改进体系，不用于考核个人（否则上报真实性失真）
- 每季度人工抽查：verify 脚本检查项是否覆盖新增目录/skill（检查器防腐，元原则 §3.6）
