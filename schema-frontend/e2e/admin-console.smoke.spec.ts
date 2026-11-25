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

  // 对单一区域注入一次可控失败，其他区域仍走真实后端。
  const throughputPath = '**/api/ops/health/tenant/api-throughput';
  let injected = false;
  await page.route(throughputPath, async route => {
    if (!injected) {
      injected = true;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: '冒烟受控失败' }) });
    } else {
      await route.continue();
    }
  });
  await page.getByRole('tab', { name: '健康状态' }).click();

  const resp = await overviewResp;
  expect(resp.status(), 'overview 请求必须成功').toBe(200);
  const body = (await resp.json()) as { activeUsersLastHour?: number };
  expect(typeof body.activeUsersLastHour, 'overview 必须返回 activeUsersLastHour').toBe('number');

  // 核心断言：页面指标卡片存在，且数值与响应一致
  // ⚠️ 两个坑（CI 实测踩到）：
  //  1) `.filter({ hasText })` 会同时命中「外层 Card」与「内层 Statistic」→ strict violation
  //  2) 取 `.first()` 拿到的是最外层容器，其内部又嵌套了多个统计卡，
  //     再 `.locator('.ant-statistic-content-value')` 会解析到 8 个元素 → strict violation
  // 解法：用 .ant-statistic 作为锚点（一张统计卡 = 一个 .ant-statistic），
  //       它本身不嵌套，内部只有唯一的值节点。
  const activeStat = page.locator('.ant-statistic').filter({ hasText: '近 1h 活跃用户' });
  await expect(activeStat).toHaveCount(1);
  await expect(activeStat).toBeVisible();
  await expect.poll(
    async () => (await activeStat.locator('.ant-statistic-content-value').innerText()).replace(/[\s,]/g, ''),
    { message: '活跃用户数必须精确匹配本次响应' },
  ).toBe(String(body.activeUsersLastHour));

  const throughput = page.locator('.ant-card').filter({ has: page.getByText('API 吞吐时序（近 60 分钟，分钟粒度）', { exact: true }) });
  await expect(throughput.getByText('冒烟受控失败', { exact: false })).toBeVisible();
  const recovered = page.waitForResponse(response => response.url().endsWith('/api/ops/health/tenant/api-throughput') && response.status() === 200);
  await throughput.getByRole('button', { name: '重试', exact: true }).click();
  await recovered;
  await expect(throughput.getByText('冒烟受控失败', { exact: false })).toHaveCount(0);
  await expect(throughput.getByText('API 吞吐时序（近 60 分钟，分钟粒度）加载失败')).toHaveCount(0);
});
