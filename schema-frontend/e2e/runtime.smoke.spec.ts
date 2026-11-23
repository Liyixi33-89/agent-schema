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