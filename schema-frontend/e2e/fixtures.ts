import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 冒烟测试共用夹具。
 *
 * 测试元数据由 CI 的播种步骤写入（不含凭据）：
 *   SMOKE_META_FILE=<path>   → { appId, appName, pageId, pageTitle }
 * 账号密码走环境变量：
 *   SMOKE_USERNAME / SMOKE_PASSWORD
 *
 * 刻意不提供 storageState 复用：首版三应用各跑一次独立登录，
 * 比维护会话文件简单，也避免 trace 里夹带会话状态。
 */

export interface SmokeMeta {
  /** 本轮创建的测试应用 ID（designer 卡片墙 / runtime 页面路由都依赖它） */
  appId: number | string;
  /** 应用名称（唯一，含时间戳，便于在卡片墙中精确定位） */
  appName: string;
  /** 本轮发布的最小页面 ID */
  pageId: number | string;
  /** 页面上的唯一可见标题（runtime 断言真实渲染，而非仅壳） */
  pageTitle: string;
}

/** 读取并校验测试元数据：缺字段立即报错，避免用占位文案假通过。 */
export function readSmokeMeta(): SmokeMeta {
  const file = process.env.SMOKE_META_FILE;
  if (!file || !fs.existsSync(file)) {
    throw new Error(`缺少测试元数据文件 SMOKE_META_FILE=${file ?? '<未设置>'}`);
  }
  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as Partial<SmokeMeta>;
  const missing = (['appId', 'appName', 'pageId', 'pageTitle'] as const)
    .filter((k) => raw[k] === undefined || raw[k] === null || String(raw[k]).trim() === '');
  if (missing.length) {
    throw new Error(`测试元数据缺字段：${missing.join(', ')}（文件 ${file}）`);
  }
  return raw as SmokeMeta;
}

/** 测试账号：缺失即报错，不回退任何默认口令。 */
export function smokeCredentials(): { username: string; password: string } {
  const username = process.env.SMOKE_USERNAME;
  const password = process.env.SMOKE_PASSWORD;
  if (!username || !password) {
    throw new Error('缺少 SMOKE_USERNAME / SMOKE_PASSWORD（隔离 CI 环境注入，不沿用公网凭据）');
  }
  return { username, password };
}

/**
 * 在真实登录界面完成登录。
 *
 * ⚠️ antd 的 <Input placeholder="账号" /> 没有关联 <label>，
 * getByRole('textbox', { name }) 拿不到可访问名（实测 element not found）。
 * 必须用 getByPlaceholder 定位——仍走真实表单交互，不是绕过 UI。
 */
export async function loginViaForm(page: Page, placeholder: RegExp): Promise<void> {
  const { username, password } = smokeCredentials();
  const account = page.getByPlaceholder(placeholder);
  await expect(account).toBeVisible();
  await account.fill(username);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
}

export const test = base.extend<{ meta: SmokeMeta }>({
  // eslint-disable-next-line no-empty-pattern
  meta: async ({}, use) => {
    await use(readSmokeMeta());
  },
});

export { expect };