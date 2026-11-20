/**
 * L2 脚本面板支撑层（08FE §2/§6——自 ScriptPanel.tsx 原样抽出，行为不变）：
 * - SAMPLE：样例脚本（编辑器初始内容）
 * - wrapWorker：DOM Worker → ScriptHost 的 WorkerLike 协议适配
 * - artifactUrlOf：产物端点（绝对 URL——Worker 从 blob: 启动，相对路径解析失败）
 * - sha256Of：源码 SHA-256（SubtleCrypto——绑定回写 sourceHash）
 * - formatLog：测试台 logger 输出格式化
 */

/** 样例脚本（编辑器初始内容——未绑定场景显示）。 */
export const SAMPLE = `export async function beforeSubmit(payload, ctx) {
  const amount = Number(payload?.record?.amount ?? await ctx.form.get('amount'));
  if (amount > 10000) {
    ctx.logger.warn('金额超阈，触发复核标记');
    await ctx.ui.toast('大额提交将进入复核', 'warning');
  }
  return true;
}
`;

/** WorkerLike 适配：DOM Worker → ScriptHost 的 WorkerLike 协议。 */
export function wrapWorker(worker: Worker): {
  postMessage(m: unknown): void;
  terminate(): void;
  addEventListener(t: 'message', l: (e: { data: unknown }) => void): void;
  removeEventListener(t: 'message', l: (e: { data: unknown }) => void): void;
} {
  return {
    postMessage: (m) => worker.postMessage(m),
    terminate: () => worker.terminate(),
    addEventListener: (t, l) => worker.addEventListener(t, l as unknown as EventListener),
    removeEventListener: (t, l) => worker.removeEventListener(t, l as unknown as EventListener),
  };
}

/** 产物端点（04BE §A.5 artifactUrl 回显优先；此处兜底拼同源绝对路径——服务端按会话租户绑定）。
 *  ⚠️ 必须绝对 URL：Worker 从 blob: URL 启动，import() 相对路径以 blob URL 为基解析直接失败。
 *  API 前缀与请求层同源真源 VITE_API_BASE（验收面 /accept 构建注入——产物路由与数据请求同域）。 */
export function artifactUrlOf(contentHash: string): string {
  return `${location.origin}${import.meta.env.VITE_API_BASE ?? ''}/api/build/artifacts/current/${contentHash}.js`;
}

/** 源码 SHA-256（审计「哪版源码」——08FE §2 sourceHash；浏览器原生 SubtleCrypto）。 */
export async function sha256Of(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 测试台 logger 输出格式化（[level] msg extra）。 */
export function formatLog(args: unknown[]): string {
  const [level, msg, extra] = args as [string, string, unknown?];
  return `[${level}] ${msg}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`;
}
