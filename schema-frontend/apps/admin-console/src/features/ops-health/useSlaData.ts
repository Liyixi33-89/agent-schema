/**
 * SLA 页数据 Hook（阶段 C 范例）：月度聚合 + 维护窗口两区域。
 * - month 变化 → 月度区域**重置**（不展示旧月份数据）；
 * - 维护窗口区域暴露完整状态（loading/refreshing/error/forbidden/stale/reload）——
 *   页面必须能区分「没有窗口」与「查询失败」；
 * - 维护窗口登记成功后刷新列表（依赖稳定的 windows.reload，不依赖整个对象）。
 */
import React from 'react';
import { createMaintenanceWindow, fetchMaintenanceWindows, fetchSlaMonthly } from './api';
import { errOf } from '../../api';
import { useAsyncData } from '../../shared/async';
import type { MaintenanceWindow, SlaMonthly } from '../../shared/contracts';
import type { AsyncState } from '../../shared/async';

export type Region<T> = AsyncState<T> & { reload: () => void };

export interface SlaData {
  monthly: Region<SlaMonthly>;
  windows: Region<MaintenanceWindow[]>;
  /** 维护窗口登记（返回执行结果文案——页面只管提示，不重复请求细节）。 */
  submitWindow: (input: { title: string; startAt: string; endAt: string; emergency: boolean }) => Promise<{ ok: true } | { ok: false; message: string }>;
}

export function useSlaData(month: string): SlaData {
  const monthly = useAsyncData((signal) => fetchSlaMonthly(month, signal), [month]);
  const windows = useAsyncData(fetchMaintenanceWindows, []);
  const reloadWindows = windows.reload;
  const submitWindow = React.useCallback(async (input: {
    title: string; startAt: string; endAt: string; emergency: boolean;
  }): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      await createMaintenanceWindow(input);
      reloadWindows();
      return { ok: true };
    } catch (e) {
      return { ok: false, message: errOf(e) };
    }
  }, [reloadWindows]);
  return { monthly, windows, submitWindow };
}