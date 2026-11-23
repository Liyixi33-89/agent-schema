/**
 * 维护窗口登记编排（纯函数——从 useSlaData.submitWindow 抽出）。
 *
 * 抽出动机（第三阶段：「单测优先直接执行生产代码」）：
 * 原实现把编排逻辑写在 React Hook 内，测试只能在用例里复制一份「同构逻辑」，
 * 生产代码改错时测试仍可能为绿。抽出后测试直接 import 本函数，
 * 任何行为变更都会被现有断言捕获。
 *
 * 依赖注入：create + errOf 由调用方传入——
 * - 生产侧传 createMaintenanceWindow 与 shared-ui 的 errOf；
 * - 测试侧传 spy，无需拉起 auth-sdk / antd 全链。
 */
import type { MaintenanceWindowInput } from '../../shared/contracts';

/** 登记结果：成功或带文案的失败（页面只管提示，不重复请求细节）。 */
export type SubmitWindowResult = { ok: true } | { ok: false; message: string };

/**
 * 登记维护窗口并在成功后刷新列表。
 *
 * 语义（与抽取前逐条一致）：
 * - 成功 → 触发 reload，返回 { ok: true }
 * - 失败 → **不** 触发 reload，返回 { ok: false, message }（message 由 errOf 归一）
 *
 * @param create 创建请求（失败时抛错）
 * @param reload 成功后刷新窗口列表
 * @param errOf  错误文案提取
 */
export async function submitMaintenanceWindow(
  input: MaintenanceWindowInput,
  create: (input: MaintenanceWindowInput) => Promise<unknown>,
  reload: () => void,
  errOf: (e: unknown) => string,
): Promise<SubmitWindowResult> {
  try {
    await create(input);
    reload();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: errOf(e) };
  }
}