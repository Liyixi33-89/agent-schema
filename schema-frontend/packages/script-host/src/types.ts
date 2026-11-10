/** L2 脚本运行时类型（08FE §2/§4）：钩子名、绑定、受控 ctx 与执行结果。 */

export type HookName =
  | 'onLoad'
  | 'onFieldChange'
  | 'beforeSubmit'
  | 'afterSubmit'
  | 'onActionClick'
  | 'onBeforeDelete';

export const HOOK_NAMES: readonly HookName[] = [
  'onLoad', 'onFieldChange', 'beforeSubmit', 'afterSubmit', 'onActionClick', 'onBeforeDelete',
] as const;

/** 页面脚本绑定（08FE §2；contentHash 为 build-service 编译产物键，旧名 artifactHash 弃用）。 */
export interface ScriptBinding {
  scriptId: string;
  hook: HookName;
  contentHash: string;
  sourceHash: string;
}

/** 主线程消息桥 op 白名单（08FE §4.2——新增 op = 安全评审 + 本表登记）。 */
export type BridgeOp =
  | 'form.get' | 'form.set' | 'form.getValues' | 'form.setValues'
  | 'api.call'
  | 'ui.toast' | 'ui.confirm' | 'ui.dialog'
  | 'log';

export const BRIDGE_OPS: readonly BridgeOp[] = [
  'form.get', 'form.set', 'form.getValues', 'form.setValues',
  'api.call',
  'ui.toast', 'ui.confirm', 'ui.dialog',
  'log',
] as const;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Worker 内注入的受控 ctx（08FE §5）：静态快照 + 消息桥动态操作。 */
export interface ScriptContext {
  form: {
    get(fieldKey: string): Promise<unknown>;
    set(fieldKey: string, value: unknown): Promise<void>;
    getValues(): Promise<Record<string, unknown>>;
    setValues(values: Record<string, unknown>): Promise<void>;
  };
  api: {
    /** 仅注册名（不接受 URL）；主线程先做权限校验再代理网关——Worker 不持 token。 */
    call(name: string, params?: unknown): Promise<unknown>;
  };
  ui: {
    toast(message: string, level?: 'info' | 'success' | 'warning' | 'error'): Promise<void>;
    confirm(message: string): Promise<boolean>;
    dialog(config: { title: string; content: string }): Promise<void>;
  };
  logger: {
    debug(message: string, extra?: unknown): void;
    info(message: string, extra?: unknown): void;
    warn(message: string, extra?: unknown): void;
    error(message: string, extra?: unknown): void;
  };
  /** 挂载时一次性静态快照注入（脱敏白名单，无手机号邮箱）。 */
  user: { id: string; roles: string[]; dept?: string } | undefined;
  page: { params: Record<string, string>; query: Record<string, string>; mode: string };
}

/** 钩子模块形态：产物必须导出至少一个钩子函数。 */
export interface HookModule {
  [hook: string]: ((...args: never[]) => unknown) | undefined;
}

export interface HookResult {
  ok: boolean;
  skipped?: boolean;
  /** beforeSubmit 返回 false 阻断提交；超时按「不阻断」放行（08FE §4.3）。 */
  value?: unknown;
  error?: string;
  durationMs: number;
  warned?: boolean;
  terminated?: boolean;
}
