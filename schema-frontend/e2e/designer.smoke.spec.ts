import { test, expect, loginViaForm } from './fixtures';

/**
 * SMK-DES-01：真实登录 → 在卡片墙找到「本轮创建的应用」。
 *
 * 必断言（缺一不可）：
 *  1. 通过真实登录表单（输入账号密码 + 提交）进入工作台
 *  2. 卡片墙出现本轮 appName —— 证明后端读到的是本轮种子应用，而非任意旧数据
 *
 * 刻意不做的：
 *  - 断言「页面返回 200」当作业务通过（壳加载 ≠ 业务可用）
 *  - 只等标题出现就结束（标题在登录失败时也可能存在）
 */
test('SMK-DES-01 登录后在卡片墙找到本轮应用', async ({ page, baseURL, meta }) => {
  // 显式拼绝对地址：baseURL 无尾斜杠时 `./` 可能解析到错误层级。
  // 保留应用前缀（/designer/），绝不 goto('/')。
  await page.goto(`${String(baseURL).replace(/\/$/, '')}/`);

  await loginViaForm(page, /账号/);

  // 登录成功后进入工作台（真实文案，非占位）
  await expect(page.getByText('设计器工作台')).toBeVisible();

  // 核心断言：本轮创建的应用卡片可见（appName 含时间戳，唯一）
  const card = page.getByText(meta.appName, { exact: false });
  await expect(card).toBeVisible();

  // 反向保证：不是「空态兜底」通过
  await expect(page.getByText('暂无应用')).toHaveCount(0);
});