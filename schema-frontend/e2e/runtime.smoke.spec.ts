import { test, expect, loginViaForm } from './fixtures';

/**
 * SMK-RUN-01：打开本轮发布的页面 → 断言真实布局渲染。
 *
 * 两级断言（关键：区分「渲染器未挂载」与「物料未渲染」）：
 *
 *  1. [data-schema-root] 存在 —— SchemaRenderer 已挂载并接管页面。
 *     该标记由 renderer/bindings.ts:68-70 的 NodeTree **无条件**输出，
 *     与是否产出可渲染节点无关；缺失即说明渲染器根本没挂上。
 *
 *  2. 根节点内出现本轮唯一标题 —— 物料真实渲染。
 *     必须用**已注册物料**（LabelText）+ 它读取的 props（label）。
 *     反例：未注册物料（如 Typography.Title）会让 NodeView 的
 *     `resolveComponent(name) ?? resolveComponent('__UnknownWidget__')`
 *     双双返回 undefined → `if (!Comp) return null` → 节点静默消失、
 *     且**不产生任何 React 错误**。此时根节点仍在、文本缺失——
 *     正是本用例要捕获的假绿形态。
 *
 * 会话获取：runtime 无登录页，先在 designer 真实登录建立 Cookie，
 * 再跳转 runtime（同站点同 Cookie 域）。仍是真实登录，不是伪造 token。
 *
 * 首版边界：只证明「发布页真实渲染」，**不宣称**登记闭环
 * （登记 → 列表 → 详情刷新 属更长业务链，按风险另行加入）。
 */
/**
 * 根因记录（2026-11-23 已在同一浏览器会话内闭环定位）：
 *
 * 现象：[data-schema-root] 存在但完全为空（rootChildCount=0），无任何 React 报错。
 *
 * 定位方法（三值同会话采集，避免跨会话/跨数据混淆）：
 *   ① 网络状态：200（非 304）→ 排除 ETag 缓存分支
 *   ② localStorage 缓存内容：firstComponent 与后端一致
 *   ③ 后端 /api/runtime/pages/{id} 实际内容：componentName 是关键
 *
 * 真因：种子用了**未注册物料** Typography.Title。
 *   renderNode 找不到物料 → componentName 改写为 '__UnknownWidget__'
 *   → NodeView `resolveComponent(name) ?? resolveComponent('__UnknownWidget__')`
 *   → DashboardPageHost.resolveComponent 两者皆 undefined
 *   → bindings.ts:144 `if (!Comp) return null` → 节点静默消失、无报错。
 *
 * 修正后实测：LabelText + props.label → rootChildCount=1，
 *   根内渲染出 <span class="ant-typography">标签唯一文本_…</span>。
 *
 * 因此本用例的两级断言正好覆盖两类失败：
 *   根标记缺失 → 渲染器未挂载
 *   根标记存在但文本缺失 → 物料未渲染（本次踩的坑）
 *
 * 其它已修正的种子缺陷：
 *   - FORM/LIST/DETAIL 需 modelId → 改 DASHBOARD（唯一允许模型为空）
 *   - path 唯一约束（避免 422 PATH_DUPLICATED）
 *   - 草稿必带 baseDraftVersion（避免 400）
 */
test('SMK-RUN-01 打开本轮发布的页面并验证真实布局渲染', async ({ page, baseURL, meta }) => {
  const designerBase = process.env.SMOKE_DESIGNER_BASE;
  if (!designerBase) {
    throw new Error('缺少 SMOKE_DESIGNER_BASE——runtime 需要先在设计器建立会话');
  }

  // 1) 在 designer 真实登录（建立会话 Cookie）
  await page.goto(`${designerBase.replace(/\/$/, '')}/`);
  await loginViaForm(page, /账号/);
  await expect(page.getByText('设计器工作台')).toBeVisible();

  // 2) 带 appId/pageId 打开 runtime 已发布页面（baseURL 已含 /runtime/ 前缀）
  await page.goto(`${String(baseURL).replace(/\/$/, '')}/#/app/${meta.appId}/page/${meta.pageId}`);

  // 3) 第一级：渲染器必须挂载（无条件输出的根标记）
  const root = page.locator('[data-schema-root]');
  await expect(root, 'SchemaRenderer 未挂载：[data-schema-root] 缺失').toBeVisible();

  // 4) 第二级：根节点内出现本轮唯一标题（物料真实渲染）
  await expect(
    root.getByText(meta.pageTitle, { exact: false }),
    `渲染器已挂载但物料未渲染：根节点内找不到「${meta.pageTitle}」。`
    + '常见原因是种子用了未注册物料（会静默消失且无报错）。',
  ).toBeVisible();

  // 5) 反向保证：未落入会话失效页（否则上面的断言可能被错误页掩盖）
  await expect(page.getByText('登录已失效')).toHaveCount(0);
});