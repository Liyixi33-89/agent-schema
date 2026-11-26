import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, smokeCredentials } from './fixtures';

/**
 * TRIGGER_FLOW 动作消费 E2E（spec 022 T4 / A7）。
 *
 * ## 覆盖
 * - SMK-TRF-01：表单配置 TRIGGER_FLOW → 提交后流程实例自动创建，审批人待办出现
 * - SMK-TRF-02（A7 回归）：**未配置 TRIGGER_FLOW → 提交后不产生任何流程实例**
 * - SMK-TRF-03（A7 矩阵）：重复发起 → INSTANCE_ALREADY_RUNNING，且前端提示可读
 *
 * ## 造数据链路（真实 API，非 mock）
 * ```
 * POST /api/models                    → 模型（currentVersion=1）
 * POST /api/models/{id}/precheck      → confirmToken（INFO 档也要 token）
 * POST /api/models/{id}/schema        → 加字段（baseVersion 必须=当前版本）
 * POST /api/pages                     → 页面（type/path/pageKey 必填）
 * PUT  /api/pages/{id}/draft          → 写入含 actions 的 schema（要 baseDraftVersion）
 * POST /api/pages/{id}/publish        → 发布
 * POST /api/flows + /publish          → 流程定义
 * ```
 * 这些契约是逐段实测确认的（见 PR 描述「探查记录」）。
 */

interface Ctx {
  base: string;
  origin: string;
  ctx: BrowserContext;
  h: Record<string, string>;
  myUserId: string;
}

async function prepare(page: Page, baseURL?: string): Promise<Ctx> {
  const base = String(baseURL).replace(/\/$/, '');
  const ctx = page.context();
  const explicit = process.env.SMOKE_API_BASE;
  const origin = explicit && explicit.trim() !== ''
    ? explicit.replace(/\/$/, '')
    : new URL(base).origin;

  await ctx.request.get(`${origin}/api/auth/csrf`);
  const c1 = (await ctx.cookies()).find((c) => c.name === 'schema_csrf')?.value ?? '';
  const cred = smokeCredentials();
  await ctx.request.post(`${origin}/api/auth/login`, {
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-CSRF-Token': c1 },
    data: { username: cred.username, password: cred.password },
  });
  const csrf = (await ctx.cookies()).find((c) => c.name === 'schema_csrf')?.value ?? '';
  // X-App-Id 是元数据/页面写操作的必需头（缺则 403 permDenied）
  const h = {
    'Content-Type': 'application/json', Origin: origin,
    'X-CSRF-Token': csrf, 'X-App-Id': '1',
  };

  const me = await (await ctx.request.get(`${origin}/api/me`)).json() as { userId?: number };
  const myUserId = String(me.userId ?? 1);
  return { base, origin, ctx, h, myUserId };
}

/** 建模型并加字段；返回 { modelId, modelKey }。 */
async function createModel(c: Ctx, name: string): Promise<{ modelId: string; modelKey: string }> {
  const modelKey = `t4${Date.now().toString(36)}`;
  const created = await (await c.ctx.request.post(`${c.origin}/api/models`, {
    headers: c.h, data: { modelKey, name },
  })).json() as { id?: string; currentVersion?: number };
  expect(created.id, '模型创建应返回 id').toBeTruthy();
  const modelId = String(created.id);
  const baseVersion = created.currentVersion ?? 1;

  // 字段类型用协议枚举（text/number），不是 string
  const changes = [
    { op: 'ADD_FIELD', fieldKey: 'title', field: { label: '标题', type: 'text', required: true } },
    { op: 'ADD_FIELD', fieldKey: 'amount', field: { label: '金额', type: 'number' } },
  ];
  const pre = await (await c.ctx.request.post(`${c.origin}/api/models/${modelId}/precheck`, {
    headers: c.h, data: { changes },
  })).json() as { confirmToken?: string; confirmMode?: string };
  expect(pre.confirmToken, 'precheck 应签发 token（INFO 档也要）').toBeTruthy();

  const saved = await c.ctx.request.post(`${c.origin}/api/models/${modelId}/schema`, {
    headers: c.h,
    data: { changes, baseVersion, confirmToken: pre.confirmToken },
  });
  expect(saved.ok(), `字段保存应成功（${saved.status()}）`).toBeTruthy();
  return { modelId, modelKey };
}

/** 建、配、发布表单页；返回 pageId。 */
async function createFormPage(
  c: Ctx,
  opts: { name: string; modelId: string; modelKey: string; actions: unknown[] },
): Promise<string> {
  const suffix = Date.now().toString(36);
  const pageKey = `p${suffix}`;
  const path = `/p${suffix}`;

  const created = await (await c.ctx.request.post(`${c.origin}/api/pages`, {
    headers: c.h,
    // ⚠️ 字段名是 type（不是 pageType）；缺 type 会走到 assertPageType(null)
    data: { appId: 1, pageKey, name: opts.name, type: 'FORM', modelId: Number(opts.modelId), path },
  })).json() as { id?: string };
  expect(created.id, '页面创建应返回 id').toBeTruthy();
  const pageId = String(created.id);

  // 先读默认 draft，拿到服务端生成的 schema.id 与服务端期望的字段形态
  // （modelId 是字符串、schemaVersion 是数字——照抄才能过协议校验）
  const draftResp = await c.ctx.request.get(`${c.origin}/api/pages/${pageId}/draft`, { headers: c.h });
  expect(draftResp.ok(), 'draft 读取应成功').toBeTruthy();
  const draftBody = await draftResp.json() as {
    schema?: Record<string, unknown>; draftVersion?: number;
  };
  const base = draftBody.schema ?? {};
  const baseDraftVersion = draftBody.draftVersion ?? 1;

  const schema = {
    ...base,                                  // 保留服务端生成的 id / pageKey / path
    name: opts.name,
    type: 'FORM',
    modelId: opts.modelId,                    // 服务端用字符串（协议 modelId: string）
    // ⚠️ 必须是整数：服务端默认草稿里是 1.0（JSON 浮点），
    // 而协议要求 schemaVersion: integer —— 原样回传会被判为结构不符（422）。
    schemaVersion: 1,
    // ⚠️ 物料名取自 component-materials 注册表：文本输入是 TextInput（不是 Input），
    //    用错会渲染成「未知物料」告警占位。
    //    用 placeholder 定位（渲染器不注入 field.label 到 DOM 的 label 关联）。
    layout: [
      { id: 'n1', componentName: 'TextInput', props: { placeholder: '请输入标题' }, fieldRef: 'title' },
      { id: 'n2', componentName: 'NumberInput', props: {}, fieldRef: 'amount' },
    ],
    actions: opts.actions,
  };
  const drafted = await c.ctx.request.put(`${c.origin}/api/pages/${pageId}/draft`, {
    headers: c.h, data: { schema, baseDraftVersion },
  });
  if (!drafted.ok()) {
    // 失败时把服务端原因带进报错（否则只有状态码，排查成本高）
    const err = await drafted.text();
    throw new Error(`draft 保存失败 ${drafted.status()}：${err.slice(0, 400)}`);
  }

  // 发布是**应用维度**的（不是单页发布）：
  // POST /api/apps/{appId}/publish  body: { pageIds: [...], changelog? }
  const pub = await c.ctx.request.post(`${c.origin}/api/apps/1/publish`, {
    headers: c.h,
    data: { pageIds: [Number(pageId)], changelog: 'T4 e2e' },
  });
  if (!pub.ok()) {
    const err = await pub.text();
    throw new Error(`页面发布失败 ${pub.status()}：${err.slice(0, 400)}`);
  }
  return pageId;
}

/** 建并发布流程（USER 模式审批人自指）。 */
async function createFlow(c: Ctx, name: string): Promise<string> {
  const flowKey = `f${Date.now().toString(36)}`;
  const schema = {
    flowKey, name, version: 1, schemaVersion: 1,
    nodes: [
      { id: 'start_1', type: 'START', name: '开始' },
      { id: 'approval_1', type: 'APPROVAL', name: '主管审批',
        approver: { mode: 'USER', userIds: [c.myUserId] } },
      { id: 'end_1', type: 'END', name: '结束' },
    ],
    edges: [
      { id: 'edge_1', from: 'start_1', to: 'approval_1' },
      { id: 'edge_2', from: 'approval_1', to: 'end_1' },
    ],
  };
  const created = await (await c.ctx.request.post(`${c.origin}/api/flows`, {
    headers: c.h, data: { appId: 1, flowKey, name, flowSchema: schema },
  })).json() as { id?: string };
  expect(created.id, '流程创建应返回 id').toBeTruthy();
  const pub = await c.ctx.request.post(`${c.origin}/api/flows/${created.id}/publish`, { headers: c.h });
  expect(pub.ok(), '流程发布应成功').toBeTruthy();
  return String(created.id);
}

/** 打开表单页、填标题、提交。 */
async function fillAndSubmit(page: Page, base: string, pageId: string, title: string): Promise<void> {
  const log: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/data/') && r.method() === 'POST') {
      const h = r.headers();
      log.push(`REQ ${r.url()} csrf=${h['x-csrf-token'] ?? '(无)'} keys=${Object.keys(h).join(',')}`);
    }
  });
  page.on('response', async (r) => {
    if (r.url().includes('/api/data/')) {
      let b = '';
      try { b = (await r.text()).slice(0, 200); } catch { /* ignore */ }
      log.push(`${r.status()} ${r.request().method()} ${r.url()} :: ${b}`);
    }
  });
  (page as unknown as { __log: string[] }).__log = log;
  await page.goto(`${base}/#/page/${pageId}`);
  // 用 placeholder 定位：渲染器不把 field.label 关联到 input 的 aria-label，
  // getByLabel('标题') 找不到元素（实测）。placeholder 由 props 直接透传给 TextInput。
  const titleInput = page.getByPlaceholder('请输入标题');
  await expect(titleInput).toBeVisible({ timeout: 20_000 });
  await titleInput.fill(title);
  await page.getByRole('button', { name: /提\s*交/ }).click();
}

test.describe('TRIGGER_FLOW 动作消费', () => {
  test('SMK-TRF-01 配置 TRIGGER_FLOW → 提交后自动发起，待办出现', async ({ page, baseURL }) => {
    const c = await prepare(page, baseURL);
    const { modelId, modelKey } = await createModel(c, 'T4 报销模型');
    const flowId = await createFlow(c, 'T4 报销审批');
    const pageId = await createFormPage(c, {
      name: 'T4 报销表单（带流程）',
      modelId,
      modelKey,
      actions: [
        { type: 'SUBMIT', successBehavior: 'TOAST' },
        { type: 'TRIGGER_FLOW', flowId, bizKeyFrom: '' },
      ],
    });

    await fillAndSubmit(page, c.base, pageId, `报销 ${Date.now()}`);

    // 提交成功提示（TOAST 行为——不跳转，便于观察后续流程发起）
    try {
      await expect(page.getByText(/提交成功|已保存|保存成功/)).toBeVisible({ timeout: 20_000 });
    } catch (e) {
      const lg = (page as unknown as { __log?: string[] }).__log ?? [];
      console.log('[DIAG] /api/data 请求:');
      for (const l of lg) console.log('  ' + l);
      const alert = await page.locator('.ant-alert').first().textContent().catch(() => null);
      console.log('[DIAG] 页面 alert =', alert);
      throw e;
    }

    // 核心断言：流程实例已创建 → 审批中心待办能看到「主管审批」
    await page.goto(`${c.base}/#/approval`);
    await expect(page.getByText('审批中心')).toBeVisible({ timeout: 20_000 });
    const todoRow = page.locator('.ant-list-item').filter({ hasText: '主管审批' }).first();
    await expect(todoRow, 'TRIGGER_FLOW 应自动发起流程并产生待办').toBeVisible({ timeout: 20_000 });
  });

  test('SMK-TRF-02（A7 回归）未配置 TRIGGER_FLOW → 提交后不发起流程', async ({ page, baseURL }) => {
    const c = await prepare(page, baseURL);
    const { modelId, modelKey } = await createModel(c, 'T4 普通模型');
    const pageId = await createFormPage(c, {
      name: 'T4 普通表单（无流程）',
      modelId,
      modelKey,
      // 只有 SUBMIT —— 改造前的形态，行为必须完全不变
      actions: [{ type: 'SUBMIT', successBehavior: 'TOAST' }],
    });

    await fillAndSubmit(page, c.base, pageId, `普通 ${Date.now()}`);
    await expect(page.getByText(/提交成功|已保存|保存成功/)).toBeVisible({ timeout: 20_000 });

    // 零行为证据：不出现任何流程相关提示
    await expect(page.getByText(/流程已发起|流程发起失败|流程未发起/)).toHaveCount(0);
  });

  test('SMK-TRF-03（A7 矩阵）重复发起 → INSTANCE_ALREADY_RUNNING', async ({ page, baseURL }) => {
    const c = await prepare(page, baseURL);
    const { modelId, modelKey } = await createModel(c, 'T4 重复模型');
    const flowId = await createFlow(c, 'T4 重复审批');
    const pageId = await createFormPage(c, {
      name: 'T4 重复表单',
      modelId,
      modelKey,
      actions: [
        { type: 'SUBMIT', successBehavior: 'TOAST' },
        { type: 'TRIGGER_FLOW', flowId, bizKeyFrom: '' },
      ],
    });

    // 第一次提交：由前端 TRIGGER_FLOW 正常发起
    await fillAndSubmit(page, c.base, pageId, `重复 ${Date.now()}`);
    await expect(page.getByText(/提交成功|已保存|保存成功/)).toBeVisible({ timeout: 20_000 });

    // 找到刚建的记录，对同一记录重复发起 → 必须 409 INSTANCE_ALREADY_RUNNING
    const listResp = await c.ctx.request.post(`${c.origin}/api/data/${modelId}/query`, {
      headers: c.h, data: { page: 0, size: 1 },
    });
    expect(listResp.ok(), '查询记录应成功').toBeTruthy();
    const list = await listResp.json() as { list?: { id: string | number }[] };
    const recordId = list.list?.[0]?.id;
    expect(recordId, '应能查到刚提交的记录').toBeTruthy();

    const dup = await c.ctx.request.post(
      `${c.origin}/api/records/${modelId}/${recordId}/flow/start`,
      { headers: c.h, data: { flowDefId: Number(flowId) } },
    );
    expect(dup.status(), '重复发起应被拒绝（409）').toBe(409);
    const body = await dup.json() as { code?: string };
    expect(body.code, 'A7 矩阵：重复发起错误码').toBe('INSTANCE_ALREADY_RUNNING');
  });
});