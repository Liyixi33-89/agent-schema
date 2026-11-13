# M15 独立审查（independent-session 四维审查 · run 20261113-131018-6daa7df）

- 审查对象：docs/acceptance/M15/20261113-131018-6daa7df（manifest 哈希覆盖 8 文件）
- 审查基线：单人轻量流程（singleReviewerMode enabled，2026-11-09 会话决策）——
  reviewer≠implementer 与四维 scope 由 coverage_issues 强制，独立 GitHub 批准豁免登记。
- 结论：**通过**。四个维度逐一复核如下。

## 维度一：范围完整性（需求矩阵 → 实际断言映射）

台账 M15 两项验收均有归档场景清单覆盖：

| 台账要求 | 覆盖断言 | 判定 |
| --- | --- | --- |
| mvp-demo：建模、页面、权限、发布、表单列表与埋点完整浏览器闭环 | m15-mvp 54 场景（result.json 哈希入 manifest）：两段式建模/三页发布/成员角色授权链/浏览器表单面板交互（含日期）/落库三面核对/埋点契约/M12R 回归 | 覆盖 |
| security：依赖图 M15 全部安全攻防项有正负例证据 | m15-security 30 场景：A1-A6 六项必验全部实际执行（missedRequired=0），A3 三要素（可达对照组+violation+未执行）齐备 | 覆盖 |

覆盖处置复核：
- 日期：MVP02-日期控件面板选择成功（面板真实交互 expenseDate=2026-11-13 非污染通道）+
  日期值随提交落库断言——已真实覆盖，不再是显式跳过。
- 附件：产品缺口如实登记（宿主未注入 uploader），处置为登记分期随 M16——**接受**。
  依据：协议字段类型 file 与冻结枚举一致，验收不替产品补功能；分期在报告显式声明非静默排除。
- 设计者浏览器操作：M13 台账已 accepted（画布交互深度验收），M15 复用结论——接受。

## 维度二：证据真实性（可复算性抽查）

- manifest：sourceCommit=6daa7df（HEAD 实测一致）、workingTreeClean=true、
  双套件 exitCode=0 与 result.json 逐项 pass 一致（30+54 断言零 skip 零 missedRequired）。
- 版本关系核查（关键）：套件 HEAD 6daa7df ≠ 被测前端构建源码 a6247e1 ≠ 后端构建 7a60b2a。
  三者关系已显式声明而非笼统声称同版：a6247e1→6daa7df 的差异全部在 scripts/acceptance/
  工具链内（git diff --name-only 实现路径为空），符合 workflow.py 例外条款；前端部署哈希
  由探针实测三态一致（local=deployed，unchanged=true）；后端身份由运行接口实测
  sourceCommit=7a60b2a verifiable=true 与受控构建记录一致。**套件版本与产物版本的关系
  如实分层记录——符合「不能笼统声称全部对应最新 SHA」的用户指令**。
- 数据库备份与恢复演练（deployment-evidence.json）：备份 md5/表数登记 + 恢复演练 exit=0
  行数核对（page_schema=78/meta_model=14/flyway=16）——「静态目录备份不能替代数据库备份」
  的关切已闭环。
- 公网冒烟 12/12 与本轮互补（部署面身份可达 vs 业务安全语义）。

## 维度三：过程独立性

- 本 run 由 evidence.cjs 托管运行生成 run.json（非手写计数）；部署探针 before/after
  由探针器自动采样；
- 中间过程 run（security-final/mvp-final 系列、种子修复尝试）在报告如实列为过程记录；
- 无手填哈希：前端部署哈希=探针实测，后端身份=运行接口，JAR sha256=服务器 sha256sum 实测。

## 维度四：遗留与风险

- 遗留登记：附件 uploader 注入（M16 分期）、Monaco 接入（M14 已登记 P2）、
  服务器隧道 nginx 配置收尾清理（schema-accept-tunnel.conf / 18097）。
- 风险提示：公网验收面为长期驻留服务，建议随 M16 上线评审统一处置（保留或下线）。
- M16 压测/RTO/RPO/上线评审按依赖图单独保留，不在 M15 范围。

## 批准

- 四维全过，M15 由 implementing 转 **accepted**。
- findings：非阻塞发现 3 项均已在报告/本审查中如实记录（附件分期、验收面驻留处置、隧道清理）。
