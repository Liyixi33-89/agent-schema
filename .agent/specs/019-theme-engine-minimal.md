---
spec_id: 019-theme-engine-minimal
status: draft
milestone: M17             # 依赖图 §5 Phase 2；spec 016 §12 A 表「主题引擎」裁决（独立小任务）
created: 2026-11-18
last_verified_at: null
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

- [ ] T1 `theme-engine` 包：类型/resolve/cssVarsOf/antdTokenOf/validateAppTheme + 单测
      （白名单拒未知键、非法 hex 拒、色阶推导 LRU、dark 算法分派）
- [ ] T2 runtime：应用清单 theme 字段消费 → 双通道注入（ThemeProvider 最小组件：CSS 变量 + ConfigProvider）
- [ ] T3 designer：应用设置「主题」页（primaryColor 色板 + darkMode 开关 + 圆角/间距/字体下拉）
      + 保存链路（PUT apps）+ 即时预览
- [ ] T4 后端核对：应用保存链路 theme 字段白名单校验（复用既有 AppUpdate 链路 + 校验器）；
      应用清单响应带 theme
- [ ] T5 测试：resolve 纯函数快照、非法配置拒绝、清单无 theme 降级、刷新一致性
- [ ] T6 验证：全量 test + verify.ps1；三应用构建（admin 不接入零改动验证）

## 5. Acceptance（验收标准，可测试）

- [ ] A1 `verify -Level commit` 通过
- [ ] A2 切换主题（主色/明暗）不影响表单数据与组件状态（人工链路：主题切换后表单填写态保留）
- [ ] A3 designer 预览与 runtime 已发布页面一致（同一 resolve 输出断言 + 人工对比）
- [ ] A4 非法配置被拒：未知 token 键/非法 hex 保存被阻断（zod 预校验 + 后端二次校验双测）
- [ ] A5 旧应用（无 theme 配置）加载即平台默认主题，行为与升级前一致
- [ ] A6 对比度红线：darkMode 下错误提示/禁用态可读（AntD dark 算法自带对比度——人工抽检）
- [ ] A7 admin-console 构建零改动（不接入验证——diff 无 theme 相关行）

## 6. 验证步骤（人可复跑）

```text
1. pnpm --filter @schema/theme-engine run build && pnpm --filter @schema/theme-engine test
2. powershell -File scripts\verify.ps1
3. 人工链路：designer 改主题保存 → runtime 打开该应用页面对比 → 刷新后一致
   → 旧应用无配置显示默认 → 构造非法配置（未知键/坏 hex）保存被拒
```

## 7. 沉淀记录（结项时回填）

- （待回填）

## 8. 开工契约校准

- 本期主题为应用级即时配置，非 PageSchema 发布快照；已发布页面在下次应用装载时读取当前主题。验收不得声称旧发布版本主题不可变。
- 保存 JSON 编码须核对 AppController 当前 `str(theme)` 与存储类型，禁止对象隐式 toString；后端严格白名单、前端同判，非法存量按默认值回退并保留可观察错误。
- 装载使用实际应用详情／导航装载链，不假设 `/api/runtime/apps/current` 已存在。
- 纯核心负责校验与 token 转换；AntD 算法分派在消费方适配，不依赖未经核实的 `theme.generate`。统一 resolve(theme?) 签名。
- 应用切换、卸载恢复 CSS 变量；designer 预览局部作用域，不污染平台壳。错误／禁用态可读性须实际验证。
