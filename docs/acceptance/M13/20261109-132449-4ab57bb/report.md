# M13 页面设计器验收报告（run-id: 20261109-132449-4ab57bb）

## 1. 范围与结论

| 项 | 内容 |
|---|---|
| 工作包 | M13 页面设计器 |
| 源码提交 | 4ab57bbfc9f7114039c840c05c017e5190d7a2fe（双端受控构建绑定） |
| 环境 | 本地 Chrome headless CDP + 8090 静态代理 → SSH 隧道 → 服务器 18081 验收后端（schema_acceptance 独立库） |
| 套件 | page-designer 54/54 PASS；page-designer-race 20/20 PASS（均 exit=0） |
| 产物来源 | 双端受控构建（evidence build）：designer/runtime/admin dist + backend JAR（backendIdentity=true，JAR 内 build-source.txt 校验通过）；运行实例身份 `/api/system/build-identity` 核对 sourceCommit=4ab57bb verifiable=true |
| 结论 | 全部验收项通过；期间发现并修复 1 个真实缺陷（详见 §4） |

## 2. 环境与命令

```text
# 受控构建（干净树 HEAD=4ab57bb；后端构建注入身份并核验 JAR 内 build-source.txt）
node scripts/acceptance/evidence.cjs build .agent/build-backend.json -- powershell.exe -NoProfile -Command "mvn -f schema-platform/pom.xml -pl bootstrap -am clean package -DskipTests; exit $LASTEXITCODE"
node scripts/acceptance/evidence.cjs build .agent/build-frontend.json -- powershell.exe -NoProfile -Command "pnpm -C schema-frontend run build; exit $LASTEXITCODE"

# 部署：受控构建 JAR scp 至服务器，JDK21 启动独立验收后端（18081/schema_acceptance）
bash scripts/acceptance/server-replace-accept-backend.sh   # NEW_JAR_SHA=ce65e11c...

# 种子（幂等）：应用「报销管理」→ 模型 expense(4 字段) → 页面 expense_form → 导航 v2 → 发布
bash scripts/acceptance/server-seed-accept-data.sh http://127.0.0.1:18081

# 隧道 + 静态代理（透传 Host 保 CSRF Origin 精确匹配）
ssh -N -L 18081:127.0.0.1:18081 root@111.231.57.177
ACCEPT_BACKEND_HOST=127.0.0.1 ACCEPT_BACKEND_PORT=18081 node scripts/acceptance/serve-acceptance.cjs

# 正式验收轮（evidence 托管）
node scripts/acceptance/evidence.cjs run M13 page-designer -- node scripts/acceptance/accept-page-designer.cjs
node scripts/acceptance/evidence.cjs run M13 page-designer-race --reuse-run-id 20261109-132449-4ab57bb -- node scripts/acceptance/accept-page-designer-race.cjs
node scripts/acceptance/evidence.cjs products 20261109-132449-4ab57bb <collect-config>
```

产物稳定性：验收后重算四产物 SHA256 与 products.json 一致（stability.json unchanged=true）。部署探测：后端运行实例身份前后一致（instanceId=45d7d83e-7077-48ca-be35-128021c90a6a，sourceCommit=4ab57bb，verifiable=true）。

## 3. 验收项覆盖

### 3.1 page-designer（54 项）

- **A4 编辑内核**：UI 向导新建、空画布引导、拖入物料、撤销/重做
- **A5 属性面板**：propsSchema 渲染、改 label 即时反映画布
- **A6 表达式**：语法错误阻断保存按钮、修正后保存、草稿落库
- **A7 409 冲突**：外部保存推高版本 → 冲突弹层 → 保留草稿 → 放弃对齐
- **A8 发布预览**：grant 签发 → exchange → 发布面读取 → grant 重放拒绝
- **A9 未绑模型**：字段绑定入口渲染且提示未绑模型
- **B0-B8 绑定模型全链**：测试模型两段式创建 → 绑定页 → 拖控件绑字段 → fieldRef 落协议 → 容器嵌套 → 大纲操作 → 409 三方内容差异 → 发布预览渲染 → 删字段后标黄警示

### 3.2 page-designer-race（20 项，真实交互专项）

- **C1 模型生成默认页**（PRD 02 §2.1）：向导选模型 + Switch 默认开 → 草稿自动生成 4×FormItem 骨架，控件 fieldRef 递归核对 = title/amount/expenseDate/remark
- **C2 真实鼠标拖拽**：浏览器原生事件链（mousedown → drag×8 插值 → dragover → drop → mouseup）
- **C3 自动保存竞态**：拖慢 PUT draft 2.5s 制造保存窗口 → 窗口内继续编辑 → 30s 定时器真实触发（版本推进）→ 手动收尾保存 → 编辑内容落库 → 版本链一致
- **C4 409 保留后重存闭环**：外部推版本 → 409 弹层 →「稍后处理」→ 重开换基线 → 编辑重存成功落库

## 4. 期间发现并修复的缺陷

**新建向导「由模型生成默认布局」静默失效**（修复提交 4c5b398）：

- 现象：向导选模型 + Switch 开启提交后，页面创建成功但草稿 layout 为空（无任何报错）
- 根因：`generate` 的 antd Switch 在选中模型后才条件挂载，`initialValue` 写入不触发 onValuesChange；提交值收集依赖 onValuesChange 缓存 → generate 恒 undefined → 生成链静默跳过
- 修复：collect 抽公共 + hasModel 挂载后延迟补收集
- 验证：修复后 C1-3/C1-4 实证骨架生成（4 FormItem + 4 fieldRef 全中）

## 5. 与既有验收的关系

本轮 supersedes `docs/acceptance/M13/20261106-142603-532775a/` 与 `20261109-125603-eeec18c/`（开发迭代轮）：该两轮未绑定双端受控构建与运行实例身份；最终轮以 4ab57bb 完整产物来源链交付。

## 6. 遗留与边界

- GitHub 独立审批暂缓（单人模式；分支保护与 PR 门禁已生效）。本轮 review 仍为实现者整理，独立批准待真实独立评审人补签（workflow check 的独立评审门禁将保持未过状态，如实登记）
- C2 拖拽走 DOM 级 DragEvent 合成序列（headless 无 OS 级鼠标输入），真实进入 React 合成事件层与 onDrop 处理链
- 验收账号为合成数据（密码经环境变量注入，不落归档材料）
