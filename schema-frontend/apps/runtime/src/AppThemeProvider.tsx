/**
 * 应用主题装载（spec 019 T2 · 13FE §4 双通道注入）：
 * - 装载通道 = 导航装载链（GET /api/apps/{id}/nav?filtered=true——运行时普通用户可用；
 *   应用详情接口仅应用管理员可读不可用于运行时注入）；响应 theme 为 JSONB 原始串；
 * - CSS 变量通道：documentElement 批量 setProperty（--schema-*）；卸载/切换恢复原值；
 * - AntD 通道：ConfigProvider theme token 同步——映射统一走 theme-engine antdTokenOf
 *   （预览与 runtime 共用唯一定义点，算法分派 darkAlgorithm/defaultAlgorithm 在此接线）；
 * - 清单无 theme → 平台默认；非法存量 → resolveWithReport 降级渲染 + 黄条可观察反馈
 *   （spec 019 §8：不静默回退）；装载失败由 AppShell 错误态展示（不在此静默吞）。
 */
import React from 'react';
import { Alert, ConfigProvider, theme as antdTheme } from 'antd';
import { resolveWithReport, cssVarsOf, antdTokenOf, type AppTheme } from '@schema/theme-engine';

/** 解析 nav 响应里的 theme 字段（JSON 串或对象双兼容——宽松 Jackson 口径 ADR-013）。 */
export function parseTheme(raw: unknown): AppTheme | null {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as AppTheme; } catch { return null; }
  }
  if (raw && typeof raw === 'object') return raw as AppTheme;
  return null;
}

/** CSS 变量通道：批量写入并返回恢复函数（应用切换/卸载恢复——13FE §4）。 */
export function applyCssVars(vars: Record<string, string>): () => void {
  const prev: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = document.documentElement.style.getPropertyValue(k);
    document.documentElement.style.setProperty(k, v);
  }
  return () => {
    for (const [k, old] of Object.entries(prev)) {
      if (old === '') document.documentElement.style.removeProperty(k);
      else document.documentElement.style.setProperty(k, old);
    }
  };
}

/**
 * 应用主题 Provider：导航装载链附带 theme → 双通道注入。
 * 非法存量主题：降级平台默认渲染 + 顶部黄条可观察反馈（错误明细透出——不静默）。
 */
export function AppThemeProvider({ navTheme, children }: {
  navTheme: unknown;
  children: React.ReactNode;
}): React.ReactElement {
  const { tokens, errors } = React.useMemo(
    () => resolveWithReport(parseTheme(navTheme)), [navTheme]);
  const spec = React.useMemo(() => antdTokenOf(tokens), [tokens]);
  React.useEffect(() => {
    const restore = applyCssVars(cssVarsOf(tokens));
    return restore;   // 应用切换/卸载恢复 CSS 变量（spec 019 §8）
  }, [tokens]);
  return (
    <ConfigProvider
      theme={{
        algorithm: spec.dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: spec.token,
      }}
    >
      {errors.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="主题配置非法，已按平台默认主题渲染"
          description={`请联系应用管理员修正主题设置。错误明细：${errors.join('；')}`}
          style={{ margin: '8px 16px' }}
        />
      )}
      {children}
    </ConfigProvider>
  );
}
