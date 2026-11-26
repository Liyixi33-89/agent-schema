import { defineConfig, devices } from '@playwright/test';

/**
 * 日常浏览器冒烟（Playwright / Chromium）——替代原先的 CDP 冒烟。
 *
 * 设计约束（PR 1：接入并与 CDP 对照）：
 * - 三应用各自独立 project，按 testMatch 分文件，第一版只跑 Chromium
 * - workers: 1 / retries: 0 —— 先建立稳定基线，不靠重试掩盖问题
 * - 不在配置里启动服务：CI 由 smoke.yml 负责 PG + 后端 + 播种 + Vite preview
 * - 访问地址从环境变量传入，且**必须带应用前缀**（/designer/ /runtime/ /admin/）；
 *   绝不 page.goto('/') 跳回站点根（会命中错误的产物）
 * - 入口只允许指向隔离测试栈：未设置环境变量时直接报错，不默认回退公网
 */

/** 读取必填地址：缺失即抛错（防止误连公网或跑空白页面）。 */
function requireBase(name: string, fallbackPath: string): string {
  const raw = process.env[name];
  if (!raw || !raw.trim()) {
    throw new Error(
      `缺少环境变量 ${name}——冒烟只允许指向隔离测试栈。\n`
      + `示例：${name}=http://127.0.0.1:5173/${fallbackPath}/`,
    );
  }
  const url = raw.trim();
  if (!url.includes(fallbackPath)) {
    throw new Error(
      `${name}=${url} 未包含应用前缀 /${fallbackPath}/。\n`
      + `请传带前缀的地址（例如 http://127.0.0.1:5173/${fallbackPath}/），`
      + `否则会命中站点根目录下的错误产物。`,
    );
  }
  return url.replace(/\/$/, '');
}

const DESIGNER = requireBase('SMOKE_DESIGNER_BASE', 'designer');
const RUNTIME = requireBase('SMOKE_RUNTIME_BASE', 'runtime');
const ADMIN = requireBase('SMOKE_ADMIN_BASE', 'admin');

export default defineConfig({
  testDir: './e2e',
  // 失败证据：JUnit（CI 统计）+ 截图（仅失败）+ trace（仅失败保留）
  reporter: [
    ['list'],
    ['junit', { outputFile: 'e2e-report.xml' }],
  ],
  outputDir: 'e2e-results',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  use: {
    // 失败证据（成功轮不留 trace，避免无谓产物）
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'designer',
      testMatch: /designer\.smoke\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: DESIGNER },
    },
    {
      // 流程编辑器闭环（spec 022 T1+T2）：验交互而非仅「页面能开」。
      // 与 designer 冒烟同 baseURL（编辑器在 designer 应用的「流程」页签内）。
      name: 'flow-editor',
      testMatch: /flow-editor\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: DESIGNER },
    },
    {
      name: 'runtime',
      testMatch: /runtime\.smoke\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: RUNTIME },
    },
    {
      name: 'admin-console',
      testMatch: /admin-console\.smoke\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: ADMIN },
    },
  ],
});