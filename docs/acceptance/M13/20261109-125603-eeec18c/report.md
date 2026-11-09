# M13 页面设计器验收报告（run-id: 20261109-125603-eeec18c）

## 1. 范围与结论

| 项 | 内容 |
|---|---|
| 工作包 | M13 页面设计器 |
| 源码提交 | eeec18c（含缺陷修复 4c5b398） |
| 环境 | 本地 Chrome headless CDP + 8090 静态代理 → SSH 隧道 → 服务器 18081 验收后端（schema_acceptance 独立库）；受控构建产物（本地产物哈希与 CI 门禁绑定） |
| 套件 | page-designer 54/54 PASS；page-designer-race 20/20 PASS |
| 结论 | 全部验收项通过；期间发现并修复 1 个真实缺陷（详见 §4） |

## 2. 环境与命令

```text
# 前置：SSH 隧道（本地 18081 → 服务器验收后端 18081）+ 种子数据（幂等脚本）
ssh -N -L 18081:127.0.0.1:18081 root@111.231.57.177
bash scripts/acceptance/server-seed-accept-data.sh http://127.0.0.1:18081

# 静态代理（三 dist 合并 + /api 反代隧道远端，透传 Host 保 CSRF Origin 匹配）
ACCEPT_BACKEND_HOST=127.0.0.1 ACCEPT_BACKEND_PORT=18081 node scripts/acceptance/serve-acceptance.cjs

# 正式验收轮（evidence 工具托管，结果/日志入 run 目录）
node scripts/acceptance/evidence.cjs run M13 page-designer -- node scripts/acceptance/accept-page-designer.cjs
node scripts/acceptance/evidence.cjs run M13 page-designer-race --reuse-run-id 20261109-125603-eeec18c -- node scripts/acceptance/accept-page-designer-race.cjs
```

种子数据链（幂等，重复执行复用已有实体）：应用「报销管理」(id=1) → 模型「报销单」expense（title/amount/expenseDate/remark 4 字段，version=2）→ 页面「报销登记」expense_form → 导航树 v2 → 发布。

## 3. 验收项覆盖

### 3.1 page-designer（54 项）

- **A4 编辑内核**：UI 向导新建、空画布引导、拖入物料、撤销/重做
- **A5 属性面板**：propsSchema 渲染、改 label 即时反映画布
- **A6 表达式**：语法错误阻断保存按钮、修正后保存、草稿落库含修正表达式
- **A7 409 冲突**：外部保存推高版本 → 冲突弹层 → 保留草稿 → 放弃对齐
- **A8 发布预览**：grant 签发 → exchange → 发布面读取（预览隔离通道）→ grant 重放拒绝
- **A9 未绑模型**：字段绑定入口渲染且提示未绑模型
- **B0-B8 绑定模型全链**：测试模型创建（两段式保存）→ 绑定页 → API 绑模型 → 拖入控件并绑定字段 → fieldRef 落协议（protocol=true props=false）→ 容器嵌套（SectionCard children）→ 大纲操作 → 409 三方内容差异（节点数维度）→ 发布预览渲染表单 → 删除模型字段后设计器标黄（dashed 警示 2/2）

### 3.2 page-designer-race（20 项，真实交互专项）

- **C1 模型生成默认页**（PRD 02 §2.1）：向导选模型 + Switch 默认开 → 创建后草稿自动生成 4×FormItem 骨架，控件 fieldRef 递归核对 = title/amount/expenseDate/remark
- **C2 真实鼠标拖拽**：浏览器原生事件链（mousedown → drag ×8 步插值 → dragover → drop → mouseup），DataTransfer 携带物料标记，画布真实出现节点
- **C3 自动保存竞态**（30s 定时器真实触发）：拖慢 PUT draft 响应 2.5s 制造保存窗口 → 窗口内继续编辑 → 自动保存真实触发（draftVersion 1→2）→ 手动保存收尾 → 竞态期间编辑内容「竞态期间编辑」落库（C3-5）→ 版本链一致（1→3）
- **C4 409 保留后重存闭环**：外部保存推高版本 → 本地保存 409 →「保留我的修改，稍后处理」→ 弹层关闭且草稿保留 → 重开设计器拉服务器最新版（换基线）→ 编辑「闭环成功标记」→ 重存成功且内容落库

## 4. 期间发现并修复的缺陷

**新建向导「由模型生成默认布局」静默失效**（修复提交 4c5b398）：

- 现象：向导选模型 + Switch 开启提交后，页面创建成功但草稿 layout 为空（生成链未执行，无任何报错）
- 根因：`generate` 字段的 antd Switch 在选中模型后才条件挂载，`initialValue={true}` 写入表单**不触发 onValuesChange**；提交值收集依赖 onValuesChange 缓存，此时 generate 恒为 undefined → `if (chosen.modelId && chosen.generate)` 短路跳过生成
- 修复：collect 抽公共函数 + Switch 挂载后（hasModel 变化）延迟 50ms 补一次收集
- 验证：修复后 C1-3/C1-4 实证骨架生成（4 FormItem + 4 fieldRef 全中）

## 5. 与既有验收的关系

本轮 supersedes `docs/acceptance/M13/20261106-142603-532775a/`（该轮遗留 4 项真实交互未覆盖：自动保存竞态、409 重存闭环、真实拖拽、模型生成默认页；且该轮记录的独立评审由实现者自评，不可作为独立批准依据）。本轮全部 4 项已由 page-designer-race 套件覆盖并通过。

## 6. 遗留与边界

- GitHub 独立审批暂缓（单人模式，分支保护已生效：PR #3 经 CI verify 门禁合并）；本轮 review 仍为实现者整理，`review.md` 独立批准待真实独立评审人补签
- C2 真实拖拽走 DOM 级 DragEvent 合成序列（headless 环境无 OS 级鼠标输入）；CDP `Input.dispatchMouseEvent` 用于坐标点击场景。两者均真实进入 React 合成事件层与 onDrop 处理链
- 服务器栈种子账号为合成数据（密码经环境变量注入，不落任何归档材料）
