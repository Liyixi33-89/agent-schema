/**
 * SLA 页数据 Hook（阶段 C 范例）：月度聚合 + 维护窗口两区域。
 * - month 变化 → 月度区域**重置**（不展示旧月份数据）；
 * - 维护窗口区域暴露完整状态（loading/refreshing/error/forbidden/stale/reload）——
 *   页面必须能区分「没有窗口」与「查询失败」；
 * - 维护窗口登记成功后刷新列表（依赖稳定的 windows.reload，不依赖整个对象）。
 *
 * 登记编排已抽至 submitWindow.ts 纯函数：Hook 只做装配，
 * 使测试能直接执行生产代码而非复制「同构逻辑」。
 */
import React from 'react';
import { createMaintenanceWindow, fetchMaintenanceWindows, fetchSlaMonthly } from './api';
import { errOf } from '../../api';
import { useAsyncData } from '../../shared/async';
import type { MaintenanceWindow, MaintenanceWindowInput, SlaMonthly } from '../../shared/contracts';
import type { AsyncState } from '../../shared/async';
import { submitMaintenanceWindow, type SubmitWindowResult } from './submitWindow';

export type Region<T> = AsyncState<T> & { reload: () => void };

export interface SlaData {
  monthly: Region<SlaMonthly>;
  windows: Region<MaintenanceWindow[]>;
  /** 维护窗口登记（返回执行结果文案——页面只管提示，不重复请求细节）。 */
  submitWindow: (input: MaintenanceWindowInput) => Promise<SubmitWindowResult>;
}

export function useSlaData(month: string): SlaData {
  const monthly = useAsyncData((signal) => fetchSlaMonthly(month, signal), [month]);
  const windows = useAsyncData(fetchMaintenanceWindows, []);
  // 依赖稳定的 reload 函数（不是整个 windows 对象——否则每次渲染重建回调）
  const reloadWindows = windows.reload;
  const submitWindow = React.useCallback(
    (input: MaintenanceWindowInput) =>
      submitMaintenanceWindow(input, createMaintenanceWindow, reloadWindows, errOf),
    [reloadWindows],
  );
  return { monthly, windows, submitWindow };
}