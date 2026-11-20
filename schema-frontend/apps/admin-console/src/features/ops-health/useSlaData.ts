/**
 * SLA 页数据 Hook（阶段 C 范例）：月度聚合 + 维护窗口两区域；month 变化重载（既有行为）；
 * 维护窗口登记成功后调 reload 刷新列表（既有 load() 行为保留）。
 */
import React from 'react';
import { createMaintenanceWindow, fetchMaintenanceWindows, fetchSlaMonthly } from './api';
import { errOf } from '../../api';
import { useAsyncData } from './useAsyncData';
import type { MaintenanceWindow, SlaMonthly } from './contracts';

export interface SlaData {
  monthly: { data: SlaMonthly | null; loading: boolean; error: string | null; forbidden: boolean; stale: boolean; reload: () => void };
  windows: { data: MaintenanceWindow[] | null; loading: boolean; reload: () => void };
  /** 维护窗口登记（返回执行结果文案——页面只管提示，不重复请求细节）。 */
  submitWindow: (input: { title: string; startAt: string; endAt: string; emergency: boolean }) => Promise<{ ok: true } | { ok: false; message: string }>;
}

export function useSlaData(month: string): SlaData {
  const monthly = useAsyncData(() => fetchSlaMonthly(month), [month]);
  const windows = useAsyncData(fetchMaintenanceWindows, []);
  const submitWindow = React.useCallback(async (input: {
    title: string; startAt: string; endAt: string; emergency: boolean;
  }): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      await createMaintenanceWindow(input);
      windows.reload();
      return { ok: true };
    } catch (e) {
      return { ok: false, message: errOf(e) };
    }
  }, [windows]);
  return {
    monthly: { data: monthly.data, loading: monthly.loading, error: monthly.error, forbidden: monthly.forbidden, stale: monthly.stale, reload: monthly.reload },
    windows: { data: windows.data, loading: windows.loading, reload: windows.reload },
    submitWindow,
  };
}
