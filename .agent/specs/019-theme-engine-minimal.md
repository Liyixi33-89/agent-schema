---
spec_id: 019-theme-engine-minimal
status: done
milestone: M17             # 依赖图 §5 Phase 2；spec 016 §12 A 表「主题引擎」裁决（独立小任务）
created: 2026-11-18
last_verified_at: 2026-11-19
owner: human-lead
---

# Spec · 主题引擎最小交付（统一主题，非主题编辑器）

## 1. 背景与目标（为什么做）

- **需求来源**：spec 016 §12 A 表「主题引擎」裁决——最小交付=主题配置协议（归属/默认值/继承）
  + 有限参数（主色/字体/圆角/间距/明暗）+ theme-engine 转 AntD token 与 CSS 变量
  + designer/runtime 同源应用 + 兼容验证；第一版不做任意 CSS/自定义样式代码。
- **真源设计**：《详细前端技术文档 13 · 主题引擎与品牌定制》（13FE）——AppTheme token 体系、
  双通道注入链（CSS 变量 + AntD ConfigProvider）、热切换时序；后端 `app.theme` 存储（13BE §3.1）。
- **形态定案（本 spec 裁决，覆盖 13FE 原文）**：13FE 写「shared-ui 内 theme 模块（不独立成包）」，
  但裁决输入指定 `theme-engine` 转 token——**采用独立包 `packages/theme-engine`**（占位包已存在）：
  主题解析是纯逻辑（token merge/校验/色阶推导），独立包可单测且不把 antd 依赖带进 shared-ui 消费面；
  shared-ui 维持「跨应用 UI 组件与工具」定位。13FE 的形态描述随本 spec 结项同步修订。
- **不做会怎样**：应用品牌无法配置——所有租户应用一律平台蓝；「白标」能力空转。

## 2. 范围声明（做什么/不做什么）

**做**（裁决最小交付逐条落地）：

1. **主题配置归属与继承**：归属=**应用级**（`app.theme`，13BE §3.1 既有存储位）；
   继承=平台默认 → 应用覆盖（两层，租户层 P3 预留）；旧应用无 theme 字段 → 平台默认（兼容）。
2. **有限参数白名单（封闭集合，zod 校验）**：

   ```ts
   interface AppTheme {
     primaryColor?: string;      // hex 正则校验
     darkMode?: boolean;         // 明暗模式（默认 false）
     tokens?: {
       fontFamily?: string;      // 白名单枚举（系统字体栈，非任意 URL）
       borderRadius?: 4 | 6 | 8; // 圆角枚举
       spacing?: 'compact' | 'default' | 'loose';  // 间距档位枚举
     };
   }
   ```
   - 未知键拒绝（防 token 面积失控）；主色 → AntD `theme.generate` 派生色阶（hover/active/disabled 自动）；
   - 13FE 原白名单含 logoFileId/loginBgFileId——**本期裁掉**（依赖 file-service 凭证链，独立小任务不引入文件依赖），
     随后续版本补。
3. **theme-engine 包**：`resolve(platformDefault, appTheme?) → 生效 token 集`（纯函数，LRU 缓存色阶推导）
   + `cssVarsOf(tokens) → Record<'--schema-*', string>`（CSS 变量集）+ `antdTokenOf(tokens) → ConfigProvider token`
   + `validateAppTheme`（zod 白名单——前端预校验，保存按钮态联动）。
4. **双通道注入（runtime）**：应用清单携带 theme（`GET /api/runtime/apps/current` 扩展字段）
   → CSS 变量 `document.documentElement.style.setProperty` + AntD `<ConfigProvider theme>` 同步；
   未配置/接口失败 → 平台默认静默降级（不阻塞页面）。
5. **designer 同源**：应用设置「主题」页（保存 `PUT /api/apps/{id}` theme 字段）+
   即时预览（同一 `resolve` 函数——所见即所得）；designer 自身壳维持平台默认蓝（13FE §1——平台品牌与客户品牌分离）。
6. **admin 不跟随**：admin-console 为平台工具，维持平台默认主题（裁决「admin 是否跟随单独决定」→ 定案：不跟随）。
7. **兼容验证**：旧应用（无 theme）加载即平台默认；非法配置保存被拒（zod）；刷新后一致（theme 随清单持久下发）。

**不做**：

- 任意 CSS 注入/任意字体 URL/自定义样式代码（红线——存储型 XSS 面，13FE 已封死）→ 永久不做；
- 租户级主题覆盖（13FE 三层结构的第三层）→ P3；
- Logo/登录页背景文件（file-service 凭证链）→ 随文件能力需要补；
- 主题编辑器复杂交互（色板拖拽/实时对比预览）→ 最小版本=表单字段 + swatch 选择；
- 热切换跨会话推送（WS）→「下次启动生效」策略（13FE §4——低频变更不扩长连接协议）；
- 物料硬编码 hex 的 CI 静态扫描 → 随完整版（本期物料已无硬编码主色）。

## 3. 接口契约（对外的稳定承诺）

### 3.1 theme-engine 包导出

```ts
// packages/theme-engine/src/index.ts
export interface ThemeTokens {
  colorPrimary: string; colorSuccess: string; colorWarning: string; colorError: string;
  borderRadius: 4 | 6 | 8; fontFamily: string; spacing: 'compact' | 'default' | 'loose';
  darkMode: boolean;
}
export const PLATFORM_DEFAULT_THEME: AppTheme;                       // 平台默认（蓝 #1677ff）
export function resolve(theme?: AppTheme | null): ThemeTokens;       // 默认 → 覆盖 merge → 生效集
export function cssVarsOf(t: ThemeTokens): Record<string, string>;  // --schema-primary 等 CSS 变量
export function antdTokenOf(t: ThemeTokens): ConfigProviderProps['theme'];  // AntD token（含算法分派 dark/light）
export function validateAppTheme(v: unknown): { ok: true; value: AppTheme } | { ok: false; errors: string[] };
```

- 包依赖红线：仅 `zod`（校验）+ `antd`（theme 算法）peer——不依赖任何 @schema/* 包（纯函数层）。

### 3.2 协议与后端

- `app.theme` 存储（13BE §3.1 既有字段位）——**无协议新增**：应用清单扩展字段属后端响应面，
  校验在后端应用服务保存链路复用同一白名单（后端二次校验，前端 zod 预校验双层）；
- 涉及契约变更面：`GET /api/runtime/apps/current` 响应加 `theme?: AppTheme`——按现有宽松 Jackson
  校验（ADR-013）老后端不发字段时前端按平台默认，**前后端可独立发布**。

### 3.3 消费方接线

| 应用 | 行为 |
|---|---|
| runtime | 应用启动注入双通道；清单无 theme → 平台默认 |
| designer | 应用设置主题页（表单 + 即时预览壳）；壳自身平台蓝 |
| admin-console | 不接入（平台默认） |

## 4. Tasks（任务清单，执行时逐项勾选）

- [x] T1 `theme-engine` 包：类型/resolve/cssVarsOf/antdTokenOf/validateAppTheme + 单测 41 例
      （白名单拒未知键、非法 hex 拒、原型链键拒、dark 算法标识分派；antdTokenOf 为映射唯一定义点）
- [x] T2 runtime：导航装载链（GET /api/apps/{id}/nav?filtered=true）附带 theme → 双通道注入
      （AppThemeProvider：CSS 变量 + ConfigProvider；应用切换/卸载恢复原值；装载结果按 appId 绑定防串显）
- [x] T3 designer：应用设置「主题」页（primaryColor 色板 + darkMode 开关 + 圆角/间距/字体下拉）
      + 保存链路（PUT apps）+ 即时预览（消费同一 antdTokenOf——所见即所得）
- [x] T4 后端核对：应用保存链路 theme 白名单校验（AppService.themeErrors 二次校验，422 透出明细）；
      nav 响应带 theme 原串透传
- [x] T5 测试：theme-engine 41 例 + 双端共享校验样本同判（theme-fixtures.json 19 条正负例，
      前端 Vitest 与后端 ThemeVectorTest 消费同一份真源）+ AppServiceIT 22 例（含 4 theme 用例，
      走服务器 15433 专用 schema_it 库）
- [x] T6 验证：全量 test 401/401 + verify -Level commit 11 步全绿（backend-it 572s）；
      三应用构建（admin 零 theme 改动验证）

## 5. Acceptance（验收标准，可测试）

- [x] A1 `verify -Level commit` 通过（11 步：doc-anti-corruption/frontend-tsc/backend-compile/
      contract-diff/tools-selftest/frontend-test/backend-test/backend-it/frontend-build/runtime-build/designer-build）
- [x] A2 切换主题不影响表单数据（B1 浏览器实测：主题色变更保存后描述文本保留）
- [x] A3 designer 预览与 runtime 一致（B2 实测：预览主按钮 rgb(82,196,26) = runtime CSS 变量 #52c41a
      + AntD 样式表注入同色——同一 antdTokenOf 输出，非「AntD 算法自带对比度」的口头断言）
- [x] A4 非法配置被拒（共享样本 19 条双端同判 + 后端保存链路 422 + 前端预校验按钮态联动）
- [x] A5 旧应用无 theme 加载即平台默认（B4/B5 实测：nav theme=null → 平台蓝 #1677ff；
      切换应用不串主题、切回恢复）
- [x] A6 对比度红线（B6 实测：暗色错误文本对比度 18.42 ≥ 4.5；禁用态 2.43 可辨认——WCAG 豁免
      inactive UI，antd 暗色默认禁用色实测记录在案；暗色壳层由 --schema-bg/--schema-fg 变量驱动）
- [x] A7 admin-console 构建零改动（diff 无 theme 相关行）
- [x] A8 非法存量主题可观察反馈（B7 实测：DB 直写未知键 → runtime 黄条「主题配置非法」+
      错误明细透出 + 降级平台蓝渲染——不静默）

## 6. 验证步骤（人可复跑）

```text
1. pnpm --filter @schema/theme-engine test                    # 41 例（含共享样本 19 条）
2. mvn -pl bootstrap -am test -Dtest=ThemeVectorTest          # 后端消费同一份 theme-fixtures.json
3. powershell -File scripts\verify.ps1 -Level commit          # 11 步（IT 走 15433 隧道 schema_it 库）
   #   环境变量：VERIFY_IT_DB_HOST=127.0.0.1 VERIFY_IT_DB_PORT=15434 VERIFY_IT_DB_NAME=schema_it
   #            VERIFY_IT_DB_USER=schema_it VERIFY_IT_DB_PASS=schema_it_local_only
4. 浏览器验收（SSH 隧道 18095 loopback 面）：accept-theme-019-browser.cjs 六项场景 27 断言
```

## 7. 沉淀记录（结项回填）

- **装载通道修正**：运行时主题不走 `/api/runtime/apps/current`（该接口不存在），改由导航装载链
  nav 响应附带 theme——普通用户可用；应用详情接口仅应用管理员可读不可用于运行时注入。
- **antdTokenOf 形态修正**：13FE 原文「返回 ConfigProviderProps['theme']」会引入 antd 类型依赖——
  实际形态 `AntdThemeSpec{dark, token}`（纯数据），算法分派在消费方接线。预览与 runtime 共用唯一映射点。
- **暗色壳层缺口**：AppShell 是原生 div（非 antd Layout），darkAlgorithm 只影响 antd 组件——
  cssVarsOf 补 --schema-bg/--schema-bg-layout/--schema-fg/--schema-border，壳层消费后暗色全屏生效。
- **非法 JSON 双路径（2026-11-20 收尾核查修订）**：parseTheme 原对坏 JSON 串返回 null——
  与「无主题」不可区分，会被当合法缺省静默默认渲染（无警告）。已修正为三态返回
  `{kind:'theme'|'absent'|'invalid'}`：坏 JSON/数组/原始值 → invalid（AppThemeProvider 降级
  默认渲染 + 黄条明细反馈，不再静默吞）；null/空白串 → absent（真缺省，静默默认）。
  边界测试 `AppThemeProvider.test.tsx` 覆盖三态全分支。
- **CSS 变量恢复边界（2026-11-20 收尾核查登记）**：applyCssVars 恢复承诺 = 还原「写入前的
  内联原值」（含原值空 → removeProperty 分支；连续两轮应用嵌套还原；恢复函数幂等）——
  `AppThemeProvider.test.tsx` 注入式 style stub 全覆盖（不引 jsdom，零新增依赖红线）。
  ⚠️ 已知边界：若页面样式表存在同名 `--schema-*` 的 `!important` 声明，内联恢复无法覆盖
  （CSS 优先级铁律）——本系统 `--schema-*` 仅经本函数内联写入、样式表无同名 !important
  声明，边界成立；若未来引入全局样式表同名变量须重新评估。
- **SPA 同源 hash 切换不重载 JS**：验收跨应用断言前须 `about:blank` 中转真导航。
- **antd 两字按钮带空格**：「保存」渲染「保 存」——UI 自动化按钮匹配必须去空白。
- **ant Form 合成事件提交**：`b.click()` 不触发 onFinish（rc-field-form 拦截）；须 `form.requestSubmit(btn)`。
- **专用 IT 库**：15433 新建 schema_it + 受限账号（CONNECTION LIMIT 100）；本地隧道 15434→15433。
  ⚠️ 隧道端口复用陷阱：15434 曾被旧隧道占用转发 5432 主库（密码失败且「Role 不存在」指向主库日志）——
  建隧道前必查 `Get-NetTCPConnection -LocalPort` 的 OwningProcess 及其 CommandLine。
- **B6 对比度实测**：暗色错误文本 18.42（≥4.5 过）；disabled input 2.43（antd 暗色默认禁用色，
  WCAG 豁免 inactive UI；口径改「>2 可辨认」并记录实测值——替代原「AntD 算法自带对比度」口头验收）。

## 8. 开工契约校准

- 本期主题为应用级即时配置，非 PageSchema 发布快照；已发布页面在下次应用装载时读取当前主题。验收不得声称旧发布版本主题不可变。
- 保存 JSON 编码须核对 AppController 当前 `str(theme)` 与存储类型，禁止对象隐式 toString；后端严格白名单、前端同判，非法存量按默认值回退并保留可观察错误。
- 装载使用实际应用详情／导航装载链，不假设 `/api/runtime/apps/current` 已存在。
- 纯核心负责校验与 token 转换；AntD 算法分派在消费方适配，不依赖未经核实的 `theme.generate`。统一 resolve(theme?) 签名。
- 应用切换、卸载恢复 CSS 变量；designer 预览局部作用域，不污染平台壳。错误／禁用态可读性须实际验证。

## 9. 验收证据（2026-11-19 收口）

| 项 | 结果 | 关键证据 |
|---|---|---|
| 单元测试 | 401/401 前端全绿 | theme-engine 41 例（含共享样本 19 条同判）；架构巡航 156 modules 0 违规 |
| 后端测试 | ThemeVectorTest 2/2 + AppServiceIT 22/22 | 共享样本真源 theme-fixtures.json 双端消费；IT 走 15433 schema_it 专用库 |
| verify -Level commit | 11 步全绿 | doc-anti-corruption/契约 diff/双端编译测试/三应用构建全过；backend-it 572s |
| 浏览器验收 | 27/27 PASS（两次稳定复现） | B1 表单保留/B2 预览=runtime（rgb(82,196,26)）/B3 刷新一致/B4 切换不串色/B5 旧应用默认蓝/B6 暗色对比度 18.42/B7 非法黄条+明细 |
| API 验收 | 9/9 PASS | accept-theme-019.sh：合法保存/nav 携带 theme/非法 422/清空语义 |
| 验收脚本 | `scripts/acceptance/accept-theme-019-browser.cjs` | 可复跑（SSH 隧道 18095 loopback 面 + CDP 真实浏览器） |

验收环境：线上 18081 验收后端（裸进程）+ /accept/ 面产物（ACCEPT_BASE=1 + VITE_API_BASE=/accept 构建）。
已知边界（非阻塞）：disabled input 暗色对比度 2.43（antd 默认禁用色，WCAG 豁免 inactive UI，
实测值记录在案）；坏 JSON 串静默等价「无配置」（与未知键对象的黄条反馈路径不同，属设计预期）。
