import { test, expect, loginViaForm } from './fixtures';

/**
 * 诊断：逐步截图，定位登录与页面切换的真实行为。
 * 这是临时诊断用例，问题定位后删除。
 */
test('DIAG 登录与工作台结构', async ({ page, baseURL }) => {
  const base = String(baseURL).replace(/\/$/, '');
  console.log('[diag] baseURL =', base);

  await page.goto(`${base}/`);
  console.log('[diag] 打开后 URL =', page.url());
  console.log('[diag] 标题 =', await page.title());

  // 登录页结构
  const pwd = await page.locator('input[type="password"]').count();
  console.log('[diag] 密码框数量 =', pwd);
  const placeholders = await page.locator('input').evaluateAll(
    (els) => els.map((e) => (e as HTMLInputElement).placeholder),
  );
  console.log('[diag] 所有 input placeholder =', JSON.stringify(placeholders));

  await loginViaForm(page, /账号/);
  // 等一会儿看结果
  await page.waitForTimeout(3000);
  console.log('[diag] 登录后 URL =', page.url());
  const pwdAfter = await page.locator('input[type="password"]').count();
  console.log('[diag] 登录后密码框数量 =', pwdAfter);

  // 抓登录请求结果
  const bodyText = await page.locator('body').innerText();
  console.log('[diag] 页面文本(前 600) =', bodyText.slice(0, 600).replace(/\n+/g, ' | '));

  // 可点元素
  const buttons = await page.getByRole('button').evaluateAll(
    (els) => els.map((e) => (e.textContent ?? '').trim()).filter(Boolean),
  );
  console.log('[diag] 按钮 =', JSON.stringify(buttons));

  const tabs = await page.getByRole('tab').evaluateAll(
    (els) => els.map((e) => (e.textContent ?? '').trim()).filter(Boolean),
  );
  console.log('[diag] tab =', JSON.stringify(tabs));

  // 所有含「流程」的文字
  const flowTexts = await page.getByText('流程').evaluateAll((els) => els.length);
  console.log('[diag] 「流程」文字节点数 =', flowTexts);

  // 菜单项
  const menuItems = await page.locator('.ant-menu-item, .ant-tabs-tab').evaluateAll(
    (els) => els.map((e) => (e.textContent ?? '').trim()).filter(Boolean),
  );
  console.log('[diag] 菜单/tab =', JSON.stringify(menuItems));

  await page.screenshot({ path: 'e2e-results/diag-after-login.png', fullPage: true });
});