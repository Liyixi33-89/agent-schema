import { test, expect, loginViaForm } from './fixtures';

/**
 * 流程编辑器闭环 E2E（spec 022 T1+T2 / A2+A3 浏览器侧验证）。
 *
 * ## 前置
 * - 测试栈已部署（含 022 代码）且 COOKIE_INSECURE=1（HTTP 环境）
 * - SMOKE_DESIGNER_BASE 指向 /designer/，账号可登录
 *
 * ## 为什么先建应用
 * designer 工作台在**未选应用**时只显示卡片墙，没有「流程」页签。
 * 流程页属于应用内部页面，必须先进入某个应用。
 *
 * ## 断言策略
 * 每步断言**业务结果**（列表状态/提示文案/按钮可用性），不只断言元素存在。
 */

const uniq = () => `${Date.now().toString(36)}`;

test.describe('流程编辑器闭环', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    // 显式拼绝对地址（baseURL 无尾斜杠时 goto('/') 会落到站点根=runtime）
    await page.goto(`${String(baseURL).replace(/\/$/, '')}/`);
    await loginViaForm(page, /账号/);
    // 登录成功判据：登录表单消失 + 工作台可见
    await expect(page.locator('input[type="password"]')).toHaveCount(0, { timeout: 25_000 });
    await expect(page.getByText('设计器工作台')).toBeVisible({ timeout: 20_000 });
  });

  test('SMK-FLOW-01 新建应用 → 进流程页 → 建流程 → 保存 → 发布', async ({ page }) => {
    // ---------- 1. 新建应用（工作台入口）----------
    const appName = `E2E应用${uniq()}`;
    await page.getByRole('button', { name: /新建应用/ }).click();
    // 弹窗：填名称
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input').first().fill(appName);
    await dialog.getByRole('button', { name: 'OK' }).click();

    // 卡片墙出现新应用
    const card = page.locator('.ant-card').filter({ hasText: appName });
    await expect(card).toBeVisible({ timeout: 20_000 });

    // ---------- 2. 进入应用 → 流程页 ----------
    await card.click();
    // 应用内导航应有「流程」页签/菜单
    const flowEntry = page.getByText('流程', { exact: true }).first();
    await expect(flowEntry).toBeVisible({ timeout: 20_000 });
    await flowEntry.click();

    // ---------- 3. 流程列表（真实接口，无 020 演示横幅）----------
    await expect(page.getByRole('button', { name: /新建流程/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('阶段 A 只读演示')).toHaveCount(0);

    // ---------- 4. 新建流程 ----------
    const key = `it_${uniq()}`;
    await page.getByRole('button', { name: /新建流程/ }).click();
    const d2 = page.getByRole('dialog');
    await expect(d2).toBeVisible();
    await d2.getByLabel('流程名称').fill('E2E 报销流程');
    await d2.getByLabel('流程标识').fill(key);
    await d2.getByRole('button', { name: /创建并编辑/ }).click();

    // ---------- 5. 编辑器就绪 ----------
    await expect(page.getByRole('button', { name: /\+ 审批/ })).toBeVisible({ timeout: 20_000 });
    // 三型节点都在（START 因全局唯一而禁用）
    await expect(page.getByRole('button', { name: /\+ 开始/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /\+ 结束/ })).toBeVisible();

    // blankSchema 已有 3 节点
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);

    // ---------- 6. 加审批节点 ----------
    await page.getByRole('button', { name: /\+ 审批/ }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(4);

    // ---------- 7. 选中节点 → 属性面板 ----------
    await page.locator('.react-flow__node').nth(1).click();
    await expect(page.getByText('节点属性')).toBeVisible();
    // 属性面板定位：删除节点按钮全局唯一（只在面板内），用它做锚点向上取容器。
    // 实测 filter({has}) + .last() 在 antd 深度嵌套下会选到错误的 div，
    // 改用 XPath 取「按钮的祖先中第一个含 combobox 的 div」——语义更贴合实际结构。
    const deleteBtn = page.getByRole('button', { name: '删除节点' });
    await expect(deleteBtn).toBeVisible();
    const panel = deleteBtn.locator('xpath=ancestor::div[.//input or .//select][1]');
    await panel.getByRole('textbox').first().fill('部门经理审批');
    await expect(page.locator('.react-flow__node').filter({ hasText: '部门经理审批' }))
      .toHaveCount(1);
    // 三个审批人模式可切换
    await panel.getByRole('combobox').selectOption('USER');
    await expect(panel.getByPlaceholder(/用户 ID/)).toBeVisible();
    await panel.getByRole('combobox').selectOption('INITIATOR_SUPERVISOR');

    // ---------- 8. 保存草稿 ----------
    await page.getByRole('button', { name: /保存草稿/ }).click();
    await expect(page.getByText(/草稿已保存/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('未保存')).toHaveCount(0);

    // ---------- 9. 发布 ----------
    await page.getByRole('button', { name: /发\s*布/ }).click();
    await expect(page.getByText(/已发布 v\d+/)).toBeVisible({ timeout: 20_000 });

    // 回列表核对状态
    await expect(page.getByRole('button', { name: /新建流程/ })).toBeVisible({ timeout: 20_000 });
    const row = page.locator('.ant-list-item').filter({ hasText: key });
    await expect(row).toBeVisible();
    await expect(row.getByText('已发布')).toBeVisible();
  });

  test('SMK-FLOW-02 发布前置自检：审批人为空时发布禁用', async ({ page }) => {
    const appName = `E2E自检${uniq()}`;
    await page.getByRole('button', { name: /新建应用/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input').first().fill(appName);
    await dialog.getByRole('button', { name: 'OK' }).click();
    await page.locator('.ant-card').filter({ hasText: appName }).click();
    await page.getByText('流程', { exact: true }).first().click();
    await page.getByRole('button', { name: /新建流程/ }).click();
    const d2 = page.getByRole('dialog');
    await d2.getByLabel('流程名称').fill('E2E 自检');
    await d2.getByLabel('流程标识').fill(`it_${uniq()}`);
    await d2.getByRole('button', { name: /创建并编辑/ }).click();
    await expect(page.getByRole('button', { name: /\+ 审批/ })).toBeVisible({ timeout: 20_000 });

    // 选审批节点 → USER 模式留空
    await page.locator('.react-flow__node').nth(1).click();
    // 属性面板定位：删除节点按钮全局唯一（只在面板内），用它做锚点向上取容器。
    // 实测 filter({has}) + .last() 在 antd 深度嵌套下会选到错误的 div，
    // 改用 XPath 取「按钮的祖先中第一个含 combobox 的 div」——语义更贴合实际结构。
    const deleteBtn = page.getByRole('button', { name: '删除节点' });
    await expect(deleteBtn).toBeVisible();
    const panel = deleteBtn.locator('xpath=ancestor::div[.//input or .//select][1]');
    await panel.getByRole('combobox').selectOption('USER');

    await expect(page.getByRole('button', { name: /发\s*布/ })).toBeDisabled();
    await expect(page.getByText('发布前待修正')).toBeVisible();
    await expect(page.getByText(/指定用户为空/)).toBeVisible();
  });

  test('SMK-FLOW-03 删除节点连带删边', async ({ page }) => {
    const appName = `E2E删除${uniq()}`;
    await page.getByRole('button', { name: /新建应用/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('input').first().fill(appName);
    await dialog.getByRole('button', { name: 'OK' }).click();
    await page.locator('.ant-card').filter({ hasText: appName }).click();
    await page.getByText('流程', { exact: true }).first().click();
    await page.getByRole('button', { name: /新建流程/ }).click();
    const d2 = page.getByRole('dialog');
    await d2.getByLabel('流程名称').fill('E2E 删除');
    await d2.getByLabel('流程标识').fill(`it_${uniq()}`);
    await d2.getByRole('button', { name: /创建并编辑/ }).click();
    await expect(page.getByRole('button', { name: /\+ 审批/ })).toBeVisible({ timeout: 20_000 });

    const edgesBefore = await page.locator('.react-flow__edge').count();
    expect(edgesBefore).toBe(2);

    await page.locator('.react-flow__node').nth(1).click();
    await page.getByRole('button', { name: /删除节点/ }).click();

    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    // 连带删边：approval 的两条边都消失
    await expect.poll(async () => page.locator('.react-flow__edge').count()).toBe(0);
  });
});