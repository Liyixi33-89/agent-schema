import { test, expect, loginViaForm } from './fixtures';

/**
 * SMK-ADM-01：打开健康页 → 断言页面指标与后端实际响应一致。
 *
 * 必断言：
 *  1. overview 请求成功（200）——只看到「健康状态」页签不算通过
 *  2. 页面展示的「近 1h 活跃用户」数值 === 该请求响应体里的
 *     activeUsersLastHour —— 证明页面渲染的是**本次真实数据**，
 *     而不是空态兜底（「—」）或缓存旧值
 */
test('SMK-ADM-01 健康页指标与后端响应一致', async ({ page, baseURL }) => {
  // 先挂响应监听，再导航——避免请求早于监听而漏抓
  const overviewResp = page.waitForResponse(
    (r) => r.url().includes('/api/ops/health/tenant/overview') && r.request().method() === 'GET',
    { timeout: 30_000 },
  );

  await page.goto(`${String(baseURL).replace(/\/$/, '')}/`);
  await loginViaForm(page, /管理员账号/);
  await expect(page.getByText('平台管理端')).toBeVisible();

  // 进入健康页签
  await page.getByRole('tab', { name: '健康状态' }).click();

  const resp = await overviewResp;
  expect(resp.status(), 'overview 请求必须成功').toBe(200);
  const body = (await resp.json()) as { activeUsersLastHour?: number };
  expect(typeof body.activeUsersLastHour, 'overview 必须返回 activeUsersLastHour').toBe('number');

  // 核心断言：页面指标卡片存在，且数值与响应一致
  // ⚠️ .filter({ hasText }) 会同时命中「外层 Card」与「内层 Statistic」→ strict mode violation。
  // 用 .first() 锁定最外层（DOM 顺序上外层在前），并断言其包含响应数值。
  const activeCard = page.locator('.ant-card').filter({ hasText: '近 1h 活跃用户' }).first();
  await expect(activeCard).toBeVisible();
  await expect(activeCard).toContainText(String(body.activeUsersLastHour));
});