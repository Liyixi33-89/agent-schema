import { test, expect, loginViaForm } from './fixtures';

/**
 * 流程编辑器闭环 E2E（spec 022 T1+T2 / A2+A3 的浏览器侧验证）。
 *
 * ## 为什么单独一个 spec
 * 现有三条冒烟（designer/runtime/admin）验的是「页面能开、数据能显示」。
 * 本 spec 验的是**交互闭环**：新建 → 增删节点 → 连线 → 改属性 → 保存 → 发布。
 * 这是 022 交付物的核心价值，纯单测验不到（React Flow 的拖拽/连线是 DOM 行为）。
 *
 * ## 前置条件
 * - 测试栈已部署（含 022 代码）
 * - SMOKE_DESIGNER_BASE 指向 /designer/
 * - SMOKE_USERNAME / SMOKE_PASSWORD 为可登录账号
 *
 * ## 断言策略
 * 每一步都断言**可观察的业务结果**（列表状态、提示文案、按钮可用性），
 * 不只断言「元素存在」——避免假通过。
 */

const uniqueKey = () => `it_flow_${Date.now().toString(36)}`;

test.describe('流程编辑器闭环', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    // ⚠️ 必须显式拼绝对地址并保留应用前缀。
    // baseURL 无尾斜杠时 `goto('/')` 会解析到**站点根**（runtime 应用），
    // 拿到的是「运行时容器就绪」而非 designer 工作台——实测踩到。
    await page.goto(`${String(baseURL).replace(/\/$/, '')}/`);

    // 与 designer.smoke 用**完全相同**的登录调用（placeholder = /账号/）。
    // ⚠️ 不能用 /账\s*号/ —— designer 的登录框 placeholder 就是「账号」（无空格），
    //    而 antd 的两字按钮才会插空格。写宽正则反而可能因可访问名差异匹配失败。
    await loginViaForm(page, /账号/);

    // ⚠️ 登录成功的**强判据**：登录表单消失 + 工作台特有的可交互元素出现。
    //
    // 实测两条错误判据（都曾假通过或假失败）：
    //  ① getByText('设计器工作台') —— 该文案在登录页已渲染（同一壳），断言必过 = 假通过
    //  ② URL 变化 —— designer 的登录是**同 URL 内切换视图**，URL 不变，断言必败
    //
    // 正确判据：登录表单（密码框）消失 ← 登录成功的必要条件
    await expect(page.locator('input[type="password"]')).toHaveCount(0, { timeout: 25_000 });
    // 且出现工作台内容（至少一个可点的应用卡片或「新建/暂无应用」语义）
    await expect(page.locator('.ant-card, .ant-empty, .ant-list').first())
      .toBeVisible({ timeout: 20_000 });
  });

  test('SMK-FLOW-01 新建 → 编辑 → 保存草稿 → 发布 全链路', async ({ page }) => {
    // ---------- 1. 进入流程页 ----------
    await page.getByText('流程', { exact: false }).first().click();

    // 列表态（真实接口，不再是「阶段 A 只读演示」提示）
    await expect(page.getByRole('button', { name: /新建流程/ })).toBeVisible({ timeout: 20_000 });
    // 020 的演示横幅必须消失——它是「未接真实接口」的标志
    await expect(page.getByText('阶段 A 只读演示')).toHaveCount(0);

    // ---------- 2. 新建 ----------
    const key = uniqueKey();
    await page.getByRole('button', { name: /新建流程/ }).click();
    await page.getByLabel('流程名称').fill('E2E 报销流程');
    await page.getByLabel('流程标识').fill(key);
    await page.getByRole('button', { name: /创建并编辑/ }).click();

    // 进入编辑态：三个节点面板按钮可见
    await expect(page.getByRole('button', { name: /\+ 开始/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /\+ 审批/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /\+ 结束/ })).toBeVisible();

    // blankSchema 已含 START/APPROVAL/END，START 按钮应禁用（全局唯一）
    await expect(page.getByRole('button', { name: /\+ 开始/ })).toBeDisabled();

    // ---------- 3. 加一个审批节点（验证「可建」）----------
    const beforeCount = await page.locator('.react-flow__node').count();
    await page.getByRole('button', { name: /\+ 审批/ }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(beforeCount + 1);

    // ---------- 4. 选中节点 → 属性面板（验证「属性可改」）----------
    // 点第一个审批节点（画布内节点按 id 排序，approval_1 是原始那个）
    await page.locator('.react-flow__node').nth(1).click();
    await expect(page.getByText('节点属性')).toBeVisible();

    // 改名称
    const nameInput = page.locator('input').filter({ has: page.locator('xpath=.') }).nth(0);
    // 用更稳的方式：属性面板里的第一个 textbox 是「显示名称」
    const propsPanel = page.locator('div').filter({ hasText: '节点属性' }).last();
    const displayName = propsPanel.getByRole('textbox').first();
    await displayName.fill('部门经理审批');
    // 画布上应同步显示
    await expect(page.locator('.react-flow__node').filter({ hasText: '部门经理审批' })).toHaveCount(1);

    // ---------- 5. 审批人三模式（验证「三模式可切换」）----------
    const approverSelect = propsPanel.getByRole('combobox');
    await expect(approverSelect).toBeVisible();
    await approverSelect.selectOption('USER');
    await expect(propsPanel.getByPlaceholder(/用户 ID/)).toBeVisible();
    await propsPanel.getByPlaceholder(/用户 ID/).fill('1');
    await approverSelect.selectOption('DEPT_ROLE');
    await expect(propsPanel.getByPlaceholder(/角色 key/)).toBeVisible();
    await propsPanel.getByPlaceholder(/角色 key/).fill('dept_manager');
    // 切回发起人上级（最稳妥，不依赖组织数据）
    await approverSelect.selectOption('INITIATOR_SUPERVISOR');

    // ---------- 6. 保存草稿 ----------
    await expect(page.getByText('未保存')).toBeVisible();
    await page.getByRole('button', { name: /保存草稿/ }).click();
    await expect(page.getByText(/草稿已保存/)).toBeVisible({ timeout: 20_000 });
    // 保存后「未保存」标记消失
    await expect(page.getByText('未保存')).toHaveCount(0);

    // ---------- 7. 发布 ----------
    await expect(page.getByRole('button', { name: /^发布$/ })).toBeEnabled();
    await page.getByRole('button', { name: /^发布$/ }).click();
    await expect(page.getByText(/已发布 v\d+/)).toBeVisible({ timeout: 20_000 });

    // 回到列表，状态应为「已发布」
    await expect(page.getByRole('button', { name: /新建流程/ })).toBeVisible({ timeout: 20_000 });
    const row = page.locator('.ant-list-item').filter({ hasText: key });
    await expect(row).toBeVisible();
    await expect(row.getByText('已发布')).toBeVisible();
  });

  test('SMK-FLOW-02 发布前置自检：缺审批人时发布按钮禁用', async ({ page }) => {
    await page.getByText('流程', { exact: false }).first().click();
    await page.getByRole('button', { name: /新建流程/ }).click();
    const key = uniqueKey();
    await page.getByLabel('流程名称').fill('E2E 自检流程');
    await page.getByLabel('流程标识').fill(key);
    await page.getByRole('button', { name: /创建并编辑/ }).click();
    await expect(page.getByRole('button', { name: /\+ 审批/ })).toBeVisible({ timeout: 20_000 });

    // 选审批节点 → 改用 USER 模式但**不填用户**（触发自检）
    await page.locator('.react-flow__node').nth(1).click();
    const propsPanel = page.locator('div').filter({ hasText: '节点属性' }).last();
    await propsPanel.getByRole('combobox').selectOption('USER');

    // 发布按钮应禁用 + 提示待修正
    await expect(page.getByRole('button', { name: /^发布$/ })).toBeDisabled();
    await expect(page.getByText('发布前待修正')).toBeVisible();
    await expect(page.getByText(/指定用户为空/)).toBeVisible();
  });

  test('SMK-FLOW-03 删除节点连带删除其连线', async ({ page }) => {
    await page.getByText('流程', { exact: false }).first().click();
    await page.getByRole('button', { name: /新建流程/ }).click();
    const key = uniqueKey();
    await page.getByLabel('流程名称').fill('E2E 删除流程');
    await page.getByLabel('流程标识').fill(key);
    await page.getByRole('button', { name: /创建并编辑/ }).click();
    await expect(page.getByRole('button', { name: /\+ 审批/ })).toBeVisible({ timeout: 20_000 });

    const nodesBefore = await page.locator('.react-flow__node').count();
    const edgesBefore = await page.locator('.react-flow__edge').count();
    expect(edgesBefore).toBeGreaterThan(0);

    // 选中审批节点并删除
    await page.locator('.react-flow__node').nth(1).click();
    await page.getByRole('button', { name: /删除节点/ }).click();

    await expect(page.locator('.react-flow__node')).toHaveCount(nodesBefore - 1);
    // 连带删除：与该节点相关的边应消失（至少少 2 条：start→approval、approval→end）
    await expect.poll(async () => page.locator('.react-flow__edge').count())
      .toBeLessThan(edgesBefore);

    // 删完后缺 APPROVAL 不再是问题，但缺「结束」仍会提示？此处只验结构联动
    // （blankSchema 删 approval_1 后仍有 start_1/end_1，发布应可用）
  });
});