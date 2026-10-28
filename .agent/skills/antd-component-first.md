---
name: antd-component-first
description: UI 组件选型纪律——项目组件 > Ant Design，禁引入第二套通用组件库或重复造基础件
triggers:
  - 安装依赖
  - 选组件
  - npm install
  - pnpm add
  - 新建组件
version: 1
updated: 2026-10-28
---

# AntD 优先的组件选型纪律

## 何时使用

任何「需要一个按钮/表单/表格/弹窗/下拉…」的 UI 需求，或准备执行 `pnpm add` 引入前端依赖时。

## 规则/经验

1. **选型三级优先序**：①项目已有组件（shared-ui / 物料库 / 现有页面组件）→ ②Ant Design（antd v5）→ ③与产品确认后才可引入新库。跳级直接引库 = 违规。
2. **通用组件库只有 AntD 一套**：禁止引入 MUI/Chakra/Arco/TDesign/Naive 等**任何第二套通用组件库**；禁止用 Tailwind 组件体系替代 AntD 组件语义。引入新通用库需人类授权（AGENTS.md §2 改栈级变更）。
3. **禁重复造基础件**：按钮、表单控件、表格、弹窗、抽屉、通知、日期选择、上传等 AntD 已覆盖的能力不得手写——手写版必然缺无障碍/受控/国际化，且与主题 token 脱节。
4. **专业库白名单（已定版，非通用组件库）**：React Flow（ER/流程设计器）、ECharts（图表，走 ChartKit 按需封装）、Monaco（代码编辑）、@dnd-kit（拖拽）、zod、valtio、Zustand、TanStack Query。白名单外新依赖 = 先提变更申请。
5. **AntD 用法定版**：受控优先（value/onChange 契约）；主题定制走 ConfigProvider token + CSS 变量双通道（13FE §3），禁绕过 token 直接覆盖组件内部类名样式；图标用 `@ant-design/icons` 禁内联 SVG 复制。
6. **物料层封装原则**（05FE §5）：物料 = AntD 薄封装（受控适配 + `data-node-id` 透传），**只在存在统一行为/主题/复用价值时封装**——无意义包一层（纯透传无附加）与直接散用同为反模式。
7. **版本纪律**：antd 主版本升级属于全局变更，不随业务 PR 混入。

## 反模式（踩过的坑）

- 「AntD 的 Modal 不好看」自研弹窗 → 丢失焦点陷阱/ESC/无障碍；应改 token 定制。
- 同时引入 antd + 另一套库「混用各取所长」 → 双主题体系冲突、包体翻倍、视觉割裂；统一走 AntD。
- 引入 lodash 全量（`import _ from 'lodash'`） → bundle 膨胀；按需 `lodash-es/xxx` 或原生替代。
- 复制 AntD 组件源码魔改 → 升级即碎；用封装继承（`ComponentProps`）+ token 定制。

## 验证方式

`package.json` 依赖审计：通用 UI 库仅 `antd` 一项；bundle 断言无第二组件库符号；CR 检查新组件是否先查 shared-ui（16FE 收录判据）。
