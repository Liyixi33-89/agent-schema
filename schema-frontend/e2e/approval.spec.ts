import type { BrowserContext } from '@playwright/test';
import { test, expect, smokeCredentials } from './fixtures';

/**
 * 审批中心 E2E（spec 022 T3 / A5）。
 *
 * ## 覆盖
 * - 待办列表能列出刚发起的实例任务
 * - 实例详情：流程图（FlowCanvas 实例着色）+ 办理轨迹时间线
 * - 办理：同意 → 实例 FINISHED → 待办清空 + 已办出现
 *
 * ## 数据准备
 * E2E 直接走 API 造数据（发布流程 → 发起实例），再回 UI 验证——
 * 避免依赖「设计器手工操作」这条更长的路径（那条已由 SMK-FLOW-01 覆盖）。
 *
 * ## 前置
 * - 测试栈已部署（FLOWABLE_ENABLED=true）
 * - SMOKE_RUNTIME_BASE 指向 /runtime/
 * - 账号 admin 可登录，userId=1
 */
const uniq = () => `${Date.now().toString(36)}`;

/**
 * API 基址。
 *
 * 两种部署形态：
 * - 本地/测试服务器（nginx 同源）：API 与页面同 origin，`SMOKE_API_BASE` 可不设
 * - CI（vite preview 分端口 5173/5174/5175）：API 在 18080，必须由 `SMOKE_API_BASE` 显式指定
 */
/** 登录凭据：CI 注入 accept_admin，本地 smock-meta 环境用 admin——不硬编码。 */
function creds(): { username: string; password: string } {
  return smokeCredentials();
}

/** 与 ApprovalCenter.shortId 一致：长 id 显示为前 8 位 + …。 */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

/**
 * 建一个只含 `title` 字段的模型（审批/流程 E2E 用）。
 *
 * 两段式保存：precheck 拿 token → schema 提交（baseVersion 必须是当前版本）。
 * 详见 trigger-flow.spec.ts 里对这套契约的说明。
 */
async function createModelWithTitleField(
  ctx: BrowserContext, origin: string, h: Record<string, string>, name: string,
): Promise<string> {
  const modelKey = `e2e${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const created = await (await ctx.request.post(`${origin}/api/models`, {
    headers: h, data: { modelKey, name },
  })).json() as { id?: string | number; currentVersion?: number };
  expect(created.id, '模型创建应返回 id').toBeTruthy();
  const modelId = String(created.id);
  const baseVersion = created.currentVersion ?? 1;

  const changes = [
    { op: 'ADD_FIELD', fieldKey: 'title', field: { label: '标题', type: 'text', required: false } },
  ];
  const pre = await (await ctx.request.post(`${origin}/api/models/${modelId}/precheck`, {
    headers: h, data: { changes },
  })).json() as { confirmToken?: string };
  expect(pre.confirmToken, 'precheck 应签发 token').toBeTruthy();

  const saved = await ctx.request.post(`${origin}/api/models/${modelId}/schema`, {
    headers: h, data: { changes, baseVersion, confirmToken: pre.confirmToken },
  });
  if (!saved.ok()) throw new Error(`字段保存失败 ${saved.status()}：${(await saved.text()).slice(0, 300)}`);
  return modelId;
}

/** 建一条业务记录，返回 recordId（字符串——19 位雪花 id 不能用 Number）。 */
async function createRecord(
  ctx: BrowserContext, origin: string, h: Record<string, string>,
  modelId: string, title: string,
): Promise<string> {
  const resp = await ctx.request.post(`${origin}/api/data/${modelId}`, {
    headers: h, data: { title },
  });
  if (!resp.ok()) throw new Error(`记录创建失败 ${resp.status()}：${(await resp.text()).slice(0, 300)}`);
  const text = await resp.text();
  const m = /"id"\s*:\s*"?([^",}]+)"?/.exec(text);
  if (!m) throw new Error(`记录创建响应无 id：${text.slice(0, 200)}`);
  return m[1];
}

function apiBase(pageBase: string): string {
  const explicit = process.env.SMOKE_API_BASE;
  if (explicit && explicit.trim() !== '') return explicit.replace(/\/$/, '');
  return new URL(pageBase).origin;
}

/**
 * Origin 头必须是**纯 scheme://host[:port]**（无路径）。
 *
 * 2026-11-27 修复：验收面 API 挂在 `/accept` 前缀下（apiBase 返回
 * `http://host/accept`），原实现直接把它当 Origin 头发送 →
 * 浏览器/后端 CSRF 校验判为非法 Origin（Origin 语义不允许带 path）。
 * 同源部署时 apiBase 恰好没有路径，所以这个 bug 一直没暴露。
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}


test.describe('审批中心', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    const origin = apiBase(String(baseURL));
    const ctx = page.context();

    // 先登录（经 API 上下文，cookie 落在同一浏览器上下文）
    await ctx.request.get(`${origin}/api/auth/csrf`);
    const csrf = (await ctx.cookies()).find((c) => c.name === 'schema_csrf')?.value ?? '';
    await ctx.request.post(`${origin}/api/auth/login`, {
      headers: { 'Content-Type': 'application/json', Origin: originOf(origin), 'X-CSRF-Token': csrf },
      data: { username: creds().username, password: creds().password },
    });

    // ⚠️ 登录后**再**导航：保证页面启动时 document.cookie 已含 schema_csrf，
    // 否则 runtime 首次请求带不上 X-CSRF-Token（实测 403 CSRF_TOKEN_REJECTED）。
    await page.goto(`${String(baseURL).replace(/\/$/, '')}/`);
  });

  test('SMK-APR-01 发起 → 待办 → 详情 → 办理 → 已办', async ({ page, baseURL, request }) => {
    const base = String(baseURL).replace(/\/$/, '');


    // ---------- 1. 造数据：经 API 发布流程 + 发起实例 ----------
    // 用 page.request 复用浏览器上下文（cookie 同源）
    const ctx = page.context();
    const origin = apiBase(base);

    // 取当前用户 id（CI 的 accept_admin 与本地 admin 的 id 不同，
    // USER 模式审批人必须指向真实 id，否则审批人解析为空 → 实例挂起）
    const me = await (await ctx.request.get(`${origin}/api/me`)).json() as { userId?: number };
    const myUserId = String(me.userId ?? 1);
    const cookies2 = await ctx.cookies();
    const csrf2 = cookies2.find((c) => c.name === 'schema_csrf')?.value ?? '';
    // X-App-Id 是元数据/页面写操作的必需头（缺则 403 PERM_DENIED，实测确认）
    const h = {
      'Content-Type': 'application/json', Origin: originOf(origin),
      'X-CSRF-Token': csrf2, 'X-App-Id': '1',
    };

    const key = `e2e${uniq()}`;
    const schema = {
      flowKey: key, name: 'E2E 审批流程', version: 1, schemaVersion: 1,
      nodes: [
        { id: 'start_1', type: 'START', name: '开始' },
        { id: 'approval_1', type: 'APPROVAL', name: '主管审批',
          approver: { mode: 'USER', userIds: [myUserId] } },
        { id: 'end_1', type: 'END', name: '结束' },
      ],
      edges: [
        { id: 'edge_1', from: 'start_1', to: 'approval_1' },
        { id: 'edge_2', from: 'approval_1', to: 'end_1' },
      ],
    };
    const created = await (await ctx.request.post(`${origin}/api/flows`, {
      headers: h, data: { appId: 1, flowKey: key, name: 'E2E 审批流程', flowSchema: schema },
    })).json() as { id: string };
    expect(created.id, '流程创建应返回 id').toBeTruthy();

    await ctx.request.post(`${origin}/api/flows/${created.id}/publish`, { headers: h });

    // 2026-11-27 授权修复后，发起流程要求业务记录**真实存在且可见**。
    // 原先随机造一个不存在的 recordId 直接发起已被 FORBIDDEN 拦下（这是修复的正确行为）。
    // 改为：先建模型 + 插一条真实记录，再对它发起流程。
    const modelId = await createModelWithTitleField(ctx, origin, h, 'APR 审批模型');
    const recordId = await createRecord(ctx, origin, h, modelId, `审批 ${Date.now()}`);

    const started = await (await ctx.request.post(
      `${origin}/api/records/${modelId}/${recordId}/flow/start`, {
        headers: h, data: { flowDefId: Number(created.id) },
      })).json() as { instanceId?: string };
    const instanceId = started.instanceId;
    expect(instanceId, '发起应返回 instanceId').toBeTruthy();
    // 类型收窄：下面用它精确定位列表行（instanceId 是 string|undefined）
    if (!instanceId) throw new Error('发起流程未返回 instanceId');
    const myShortId = shortId(instanceId);

    // ---------- 2. 打开审批中心 ----------
    await page.goto(`${base}/#/approval`);
    await expect(page.getByText('审批中心')).toBeVisible({ timeout: 20_000 });

    // 待办里应出现本轮实例（用 shortId 精确匹配，避免命中历史记录）
    const todoRow = page.locator('.ant-list-item')
      .filter({ hasText: '主管审批' })
      .filter({ hasText: myShortId })
      .first();
    await expect(todoRow).toBeVisible({ timeout: 20_000 });

    // ---------- 3. 打开详情 ----------
    await todoRow.getByRole('button', { name: /查看并办理/ }).click();
    await expect(page.getByText('实例详情')).toBeVisible({ timeout: 20_000 });

    // 流程图（FlowCanvas 渲染的节点）
    await expect(page.locator('.react-flow__node')).not.toHaveCount(0, { timeout: 20_000 });
    // 办理轨迹时间线（应含「开始」与「主管审批」）
    await expect(page.getByText('办理轨迹')).toBeVisible();
    await expect(page.locator('.ant-timeline-item')).not.toHaveCount(0);

    // ---------- 诊断：挂网络与控制台监听 ----------
    const netLog: string[] = [];
    page.on('response', async (r) => {
      if (r.url().includes('/complete')) {
        let body = '';
        try { body = await r.text(); } catch { /* ignore */ }
        netLog.push(r.status() + ' ' + r.url() + ' :: ' + body.slice(0, 300));
      }
    });
    page.on('console', (m) => {
      if (m.type() === 'error') {
        netLog.push('[console] ' + m.text().slice(0, 300));
      }
    });
    page.on('pageerror', (e) => netLog.push('[pageerror] ' + String(e).slice(0, 300)));

    // ---------- 4. 办理（同意）----------
    // 「办 理」按钮在抽屉 header；页面另有「查看并办理」也含「办理」二字，
    // 因此限定在 dialog 内定位，避免匹配到列表按钮。
    await page.locator('[role="dialog"]').getByRole('button', { name: /^办\s*理$/ }).click();
    await expect(page.getByText('审批意见')).toBeVisible({ timeout: 10_000 });
    await page.locator('textarea').fill('E2E 同意');
    await page.locator('[role="dialog"]').last().getByRole('button', { name: /^同\s*意$/ }).click();

    // 成功后 toast + 详情关闭
    try {
      await expect(page.getByText(/已同意/)).toBeVisible({ timeout: 20_000 });
    } catch (e) {
      console.log('[DIAG] complete 请求与错误：');
      for (const l of netLog) console.log('  ' + l);
      throw e;
    }

    // ---------- 5. 待办清空、已办出现 ----------
    await expect(page.getByText('审批中心')).toBeVisible({ timeout: 20_000 });
    // 切到已办
    await page.getByText('已办', { exact: true }).click();
    // ⚠️ 已办列表展示 node_id（approval_1）而非节点显示名：
    //    后端 listTasksByOperator 只投影 flow_task_log + 实例绑定，不带 schema 里的 nodeName。
    const doneRow = page.locator('.ant-list-item')
      .filter({ hasText: 'approval_1' })
      .filter({ hasText: myShortId })
      .first();
    await expect(doneRow).toBeVisible({ timeout: 20_000 });
    // 「同意」在 Tag 与意见文本里各出现一次，取第一个（Tag）
    await expect(doneRow.getByText('同意').first()).toBeVisible();

    // ---------- 6. 实例状态已办结 ----------
    await doneRow.getByRole('button', { name: /查看实例/ }).click();
    // 历史实例多，多个「已办结」Tag 并存——取第一个即可证明详情已开且状态为办结
    await expect(page.getByText('已办结').first()).toBeVisible({ timeout: 20_000 });
  });

  test('SMK-APR-02 驳回必须填意见（前端拦截）', async ({ page, baseURL }) => {
    const base = String(baseURL).replace(/\/$/, '');
    const ctx = page.context();
    const origin = apiBase(base);
    const csrf2 = (await ctx.cookies()).find((c) => c.name === 'schema_csrf')?.value ?? '';
    // X-App-Id 是元数据/页面写操作的必需头（缺则 403 PERM_DENIED，实测确认）
    const h = {
      'Content-Type': 'application/json', Origin: originOf(origin),
      'X-CSRF-Token': csrf2, 'X-App-Id': '1',
    };
    const me2 = await (await ctx.request.get(`${origin}/api/me`)).json() as { userId?: number };
    const myUserId = String(me2.userId ?? 1);

    const key = `e2e${uniq()}`;
    const schema = {
      flowKey: key, name: 'E2E 驳回流程', version: 1, schemaVersion: 1,
      nodes: [
        { id: 'start_1', type: 'START' },
        { id: 'approval_1', type: 'APPROVAL', name: '驳回测试', approver: { mode: 'USER', userIds: [myUserId] } },
        { id: 'end_1', type: 'END' },
      ],
      edges: [
        { id: 'edge_1', from: 'start_1', to: 'approval_1' },
        { id: 'edge_2', from: 'approval_1', to: 'end_1' },
      ],
    };
    const created = await (await ctx.request.post(`${origin}/api/flows`, {
      headers: h, data: { appId: 1, flowKey: key, name: 'E2E 驳回流程', flowSchema: schema },
    })).json() as { id: string };
    await ctx.request.post(`${origin}/api/flows/${created.id}/publish`, { headers: h });
    // 同 SMK-APR-01：授权修复后必须对真实存在的记录发起（随机假 id 会被 FORBIDDEN 拦下）
    const modelId = await createModelWithTitleField(ctx, origin, h, 'APR 驳回模型');
    const recordId = await createRecord(ctx, origin, h, modelId, `驳回 ${Date.now()}`);
    const startedResp = await ctx.request.post(
      `${origin}/api/records/${modelId}/${recordId}/flow/start`,
      { headers: h, data: { flowDefId: Number(created.id) } });
    expect(startedResp.ok(), `发起应成功（${startedResp.status()}）`).toBeTruthy();

    await page.goto(`${base}/#/approval`);
    const row = page.locator('.ant-list-item').filter({ hasText: '驳回测试' }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole('button', { name: /查看并办理/ }).click();
    // 「办 理」按钮在抽屉 header；页面另有「查看并办理」也含「办理」二字，
    // 因此限定在 dialog 内定位，避免匹配到列表按钮。
    await page.locator('[role="dialog"]').getByRole('button', { name: /^办\s*理$/ }).click();

    // 不填意见直接驳回 → 前端应拦截
    await page.locator('[role="dialog"]').last().getByRole('button', { name: /^驳\s*回$/ }).click();
    await expect(page.getByText(/驳回必须填写审批意见/)).toBeVisible({ timeout: 10_000 });
  });
});
