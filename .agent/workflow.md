# 证据驱动工作流

## 使用入口

在项目根目录执行：

```text
python scripts/workflow.py status
python scripts/workflow.py next
python scripts/workflow.py start FIX-M9
python scripts/workflow.py implemented FIX-M9
python scripts/workflow.py check FIX-M9
python scripts/workflow.py accept FIX-M9
python scripts/workflow.py reopen FIX-M9
```

用户可直接派发：「继续下一个可执行任务，按证据验收推进」。这是会话执行约定，不是无人值守后台服务。

## 真源与范围

- `docs/MVP开发任务依赖顺序图.md`：需求与依赖基线，不由此工具修改。
- `.agent/workflow.json`：唯一结构化执行台账，允许维护实时状态；不要在 README/skills 复制进度。
- `.agent/specs/`：详细任务规格。台账中合并里程碑是审查工作包，不代表修改依赖图任务编号。
- 当前 acceptance 是最低审查入口，不是完整需求覆盖证明。每次 start 后先读对应设计小节，拆出完整可测试验收项；跨里程碑工作包须分别覆盖每个子项。
- `implemented` 表示已有代码，不表示通过验收；历史提交不自动转换为 accepted。
- 当前缺失证据全部保留为空，不补造历史报告。分期必须取得人工批准，记录批准范围与出处，不能由 AI 自行把硬要求降级。

## 单任务执行协议

1. 执行 status/next，优先关闭高危缺陷；implemented 任务需显式复核，不会被 next 自动重新实现。
2. start 后读 spec 与设计小节；列齐验收项与负例，补详细 spec，然后最小修改。
3. 跑 lint、目标测试与 verify；HTTP/浏览器/并发要求不得用纯函数测试替代。
4. 标记 implemented。提交代码后，以提交 HEAD 跑验证并保留真实报告。
5. 每条 acceptance 写入 evidence：commit、command、report（仓库相对路径）、passed。
6. 由不同审查者核查需求覆盖和报告，填 review；check 只是结构校验，不替代独立审查。
7. accept 检查全部证据对应 HEAD、报告存在、前置 accepted、实现目录无未提交改动。
8. 发现缺陷执行 reopen，撤销本任务证据，并阻塞已验收的下游任务。blocked 需人工核实原因后显式改为 planned；不自动解除。

证据格式（写入对应验收项，不包含凭证或真实用户数据）：

```json
{"commit":"完整提交 SHA","command":"实际运行命令","report":".agent/evidence/任务/报告.txt","passed":true}
```

独立审查格式：

```json
{"approved":true,"commit":"完整提交 SHA","reviewer":"审查者标识","report":".agent/evidence/任务/review.md"}
```

报告应包含执行时刻、真实退出码、测试数量和结果，不得通过管道吞掉原命令退出码。证据对应当前 HEAD；代码推进后如需再次验收必须重跑，避免把旧测试用于新代码。

## 自动化边界

脚本不运行测试、不验证人工报告真实性、不保证需求清单完整、不自动提交或推送。
独立审查者、人工分期决策和上线批准不可由实现者勾选替代。CI 绿只证明所运行测试通过。
M16 可提前执行，外部试点必须同时满足 M15/M16 accepted 和人工上线评审。
新增依赖、配置、DDL、docs 基线修改仍遵守项目授权规则。
