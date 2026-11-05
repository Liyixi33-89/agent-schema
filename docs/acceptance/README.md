# 验收证据管理规范

本文件是证据目录、归档与留存规则的唯一真源。执行状态仍以 `.agent/workflow.json` 为准，状态转换遵循 `.agent/workflow.md`。

## 1. 目录边界

| 位置 | 允许内容 | 禁止内容 |
|---|---|---|
| `scripts/acceptance/` | 可复用验收脚本、公共驱动、环境启动工具 | 新增正式报告、截图、结果 JSON、业务数据 |
| `scripts/acceptance/out/<run-id>/` | 本轮结果、日志、截图、临时查询文件、临时浏览器 profile | 直接作为 accepted 的正式证据；提交 Git |
| `docs/acceptance/<work-package>/<run-id>/` | 脱敏后的正式报告、独立评审、必要原始结果与截图 | 凭证、浏览器 profile、上传数据、重复副本 |
| `.agent/` | 台账、规格、规范、验证度量 | 新增证据归档目录、复制正式报告 |

历史材料集中到各工作包的 `legacy/`，不再追加新运行结果。迁移清单见 `legacy-migration.json`（原路径、目标路径、原始与归档 SHA256）；仅引用路径允许修订，不改变验收结论。跨工作包材料保持整体，不强行拆分。

## 2. 命名与归档结构

`work-package` 使用台账工作包 ID；一次运行使用一个唯一 `run-id`，推荐 `YYYYMMDD-HHmmss-<short-sha>-<suffix>`。时间使用 UTC+8，元数据同时记录带时区的 ISO 8601 时间。同轮多个套件共享 run-id，独立执行的套件不得冒充同一轮。

```text
docs/acceptance/<work-package>/<run-id>/
  manifest.json
  report.md
  review.md
  results/<suite>-result.json
  logs/<suite>-output.txt
  shots/<suite>/<name>.png
```

禁止覆盖已归档运行；修订结论或补跑用新 run-id，并记录 supersedes。禁止可变的 latest 文件作为台账证据。索引只链接归档，不复制结论或维护任务完成状态。

## 3. 运行与归档协议

1. 先确定工作包、验收项、目标源码提交、环境和实际命令。
2. 一次运行只写自己的输出目录。结果、截图、临时脚本、profile 和测试上传数据全部位于该目录；套件间文件名隔离。
3. 每个命令独立保存退出码与结果；FAIL、跳过、环境不可用必须如实记录，不能吞掉退出码或冒充 PASS。
4. 检查脱敏后，只复制必要证据到正式目录。保留失败证据以解释返工，不将失败运行登记为 passed。
5. report 按验收项列出覆盖范围、正负例、结果、缺口、原始材料链接。截图只能佐证，不代替网络、数据库或权限断言。
6. 不同审查者执行覆盖复核，review 引用目标源码提交和被审查 run-id；实现者不能自签独立通过。
7. 台账引用具体 report/review，并保留源码提交、实际命令与 passed。归档移动不自动授予 accepted。

## 4. manifest 必需信息

- formatVersion、workPackage、runId、startedAt、finishedAt。
- sourceCommit：完整源码 SHA；workingTreeClean：执行前实现目录是否干净。
- environment：OS、运行时版本、测试环境标识、构建来源；禁止凭证和真实数据。
- suites：每套件的名称、实际命令、退出码、PASS/FAIL/SKIPPED、通过/失败/跳过数量、材料相对路径。
- supersedes：可选，被替代运行标识与原因。

源码提交与随后保存证据的 Git 提交是两个概念，禁止把证据提交 SHA 冒充被测试的源码 SHA。当前 `workflow.py` 仍按 HEAD 严格校验；在工具升级前，须遵守现行门禁，不能仅凭本文绕过。未来支持 sourceCommit 时必须同时调整工具、测试与工作流规则。

## 5. 安全、留存与历史迁移

- 密码、Cookie、CSRF/JWT、密钥、连接凭证、真实用户数据不得进入任何归档或聊天；测试使用合成数据，日志生成时即脱敏。
- 浏览器 profile、上传文件、数据库导出不得入库。大体积材料优先 CI artifact，记录地址、摘要和到期时间；外部材料失效后不得宣称可复核。
- 正式证据随项目保留，删除须人工授权。临时输出在归档核对后可清理，默认保留最近 30 天；清理脚本未落地前不得声称已自动执行。
- legacy 材料保留原始内容与原有提交线索；缺失时间、命令、提交或退出码标记 unknown，不补造。不能追溯的材料不能用于新的验收通过。
- 迁移顺序：列全引用 → 按工作包整理 → 原内容移动 → 更新台账/文档链接 → 校验存在性与内容一致性。禁止保留两份同时被称为真源。

## 6. 落地边界

历史证据已完成集中迁移与引用同步；不改变验收状态。本地旧结果保留于 `scripts/acceptance/out/legacy/`，不作为新增正式验收依据。
现有工具只实现 `scripts/acceptance/out/` 输出隔离，尚未实现 run-id、manifest、归档校验或自动清理；这些属于后续工具改造，不视为已通过的自动门禁。

后续工具验收至少覆盖：并发运行不覆盖、失败退出码保留、路径不得逃逸工作区、凭证不归档、台账链接有效、legacy 缺信息拒绝新验收、源码与证据提交区分、归档后结果可重读。
