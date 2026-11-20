/**
 * designer 浏览器冒烟（独立会话）：
 *  D1 登录页装载 → 登录成功进入工作台壳
 *  D2 工作台卡片墙渲染（features/workspace）
 *  D3 应用设置七页签齐全（features/{models,pages,flows,members,nav,theme,publish}）
 *  D4 模型页签装载（features/models）
 *  D5 无未捕获运行时异常
 *
 * 环境：SMOKE_DESIGNER（默认 ACCEPT_BASE_URL）/ ACCEPT_ALLOW_INSECURE_ORIGIN
 */
const cdp = require('./cdp.cjs');
const { BASE, ok, record, summary } = require('./accept-lib.cjs');
const S = require('./smoke-lib.cjs');

const DESIGNER = process.env.SMOKE_DESIGNER || BASE;
const SUITE = 'smoke-designer';

(async () => {
  await cdp.launch();
  try {
    // ===== D1 登录 =====
    await cdp.goto(`${DESIGNER}/accept/designer/`);
    const loginReady = await S.waitInput('账号', 25000);
    ok('D1-1 designer 登录页装载', loginReady, '');
    if (!loginReady) throw new Error('designer 登录页未装载');

    await S.fillByPlaceholder('账号', S.USERNAME);
    await S.fillPassword(S.PASSWORD);
    await S.clickButtonByText('登录');
    const shellUp = await S.waitText('设计器工作台', 25000);
    ok('D1-2 登录成功进入工作台壳', shellUp, '');

    // ===== D2 卡片墙 =====
    const workspaceUp = await S.waitAnyText(['新建应用', '暂无应用', '无匹配应用'], 25000);
    ok('D2-1 工作台卡片墙渲染（features/workspace）', workspaceUp != null, String(workspaceUp));

    // ===== D3 七页签 =====
    const cardsReady = await S.waitSelector('.ant-card', 20000);
    ok('D3-0 应用卡片已渲染', cardsReady, '');
    const opened = await cdp.evalJs(`(() => {
      const cards = Array.from(document.querySelectorAll('.ant-card'));
      const target = cards.find(x => x.classList.contains('ant-card-hoverable'))
        || cards.find(x => x.querySelector('button'))
        || cards[0];
      if (!target) return 'missing';
      target.scrollIntoView({ block: 'center' });
      target.click();
      return 'ok';
    })()`);
    const tabs = await S.waitTabs(5, 20000);
    ok('D3-1 应用设置页签装载', opened === 'ok' && tabs.length >= 5,
      `opened=${opened} tabs=${tabs.join('/')}`);
    const expectTabs = ['模型', '页面', '流程', '成员', '导航', '主题', '发布'];
    const missing = expectTabs.filter((t) => !tabs.includes(t));
    ok('D3-2 七页签齐全（各 feature 域可编排）', missing.length === 0, `missing=${missing.join(',')}`);

    // ===== D4 模型页签 =====
    await S.clickTab('模型');
    const modelUp = await S.waitAnyText(['新建模型', '暂无模型', 'ER'], 20000);
    ok('D4-1 模型页签装载（features/models）', modelUp != null, String(modelUp));

    // ===== D5 异常 =====
    const { real, warnings } = S.splitErrors();
    ok('D5-1 无未捕获运行时异常', real.length === 0, real.slice(0, 3).join(' | '));
    record('D5-2 antd 警告清单（既有提示，不判失败）', true,
      warnings.length ? `${warnings.length} 条：${warnings.slice(0, 2).join(' | ').slice(0, 200)}` : '无');

    summary(SUITE);
  } catch (e) {
    console.error('designer 冒烟异常终止:', e.message);
    try { await cdp.shot('abort'); } catch {}
    process.exitCode = 1;
    summary(SUITE);
  } finally {
    await cdp.close();
  }
})();