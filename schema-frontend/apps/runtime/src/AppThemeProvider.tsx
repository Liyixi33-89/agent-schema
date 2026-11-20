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

/** 解析结果：raw 非法（坏 JSON / 非对象）与「无主题」区分——前者须可观察反馈（spec 019 §8）。 */
export type ParsedTheme =
  | { kind: 'theme'; value: AppTheme }
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string };

/** 解析 nav 响应里的 theme 字段（JSON 串或对象双兼容——宽松 Jackson 口径 ADR-013）。 */
export function parseTheme(raw: unknown): ParsedTheme {
  if (raw == null) return { kind: 'absent' };
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return { kind: 'absent' };
    try { return { kind: 'theme', value: JSON.parse(text) as AppTheme }; }
    catch (e) { return { kind: 'invalid', reason: `theme JSON 解析失败: ${(e as Error).message}` }; }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return { kind: 'theme', value: raw as AppTheme };
  return { kind: 'invalid', reason: `theme 须为 JSON 串或对象: ${String(raw)}` };
}

/** CSS 变量通道：批量写入并返回恢复函数（应用切换/卸载恢复——13FE §4）。
 *  边界：恢复按「卸载前原值」还原普通声明优先级——若页面样式表里存在
 *  `!important` 同名变量，内联恢复无法覆盖（CSS 优先级铁律）；本系统
 *  --schema-* 变量仅由本函数经内联写入，样式表不含 !important 同名声明，
 *  该边界已在 spec 019 §7 登记（承诺范围 = 恢复内联写入的原值）。 */
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
  const { tokens, errors } = React.useMemo(() => {
    const parsed = parseTheme(navTheme);
    if (parsed.kind === 'invalid') {
      // 坏 JSON/非对象：不能静默当「无主题」——降级默认渲染 + 明细反馈（spec 019 §8）
      return { tokens: resolveWithReport(null).tokens, errors: [parsed.reason] };
    }
    const report = resolveWithReport(parsed.kind === 'theme' ? parsed.value : null);
    return { tokens: report.tokens, errors: report.errors };
  }, [navTheme]);
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
