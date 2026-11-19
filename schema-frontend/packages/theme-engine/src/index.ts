/**
 * ThemeEngine（spec 019 · 13FE 最小实现）：主题解析纯逻辑层。
 * - 封闭白名单：AppTheme 只接受 primaryColor/darkMode/tokens.{fontFamily,borderRadius,spacing}，
 *   未知键拒绝（防 token 面积失控与存储型注入面）；非法存量按默认值回退并保留可观察错误。
 * - resolve(theme?) → 生效 ThemeTokens（平台默认 → 应用覆盖两层 merge）；
 * - cssVarsOf → CSS 变量集（--schema-* 前缀，运行时挂 documentElement）；
 * - antdTokenOf → ConfigProvider token 面向消费方的适配函数注入（本包不直接依赖 antd——
 *   AntD 算法分派在消费方接线，包保持纯函数可单测）。
 * 包依赖红线：零运行时依赖（校验器自实现，非 zod——校验面小自写更轻）。
 */
export interface AppThemeTokens {
  fontFamily?: string;           // 白名单枚举（系统字体栈）
  borderRadius?: 4 | 6 | 8;      // 圆角枚举
  spacing?: 'compact' | 'default' | 'loose';  // 间距档位枚举
}

export interface AppTheme {
  primaryColor?: string;         // hex（#rgb / #rrggbb）
  darkMode?: boolean;
  tokens?: AppThemeTokens;
}

export interface ThemeTokens {
  colorPrimary: string;
  borderRadius: 4 | 6 | 8;
  fontFamily: string;
  spacing: 'compact' | 'default' | 'loose';
  darkMode: boolean;
}

/** 字体白名单（封闭集合——非任意 URL，13FE §1 红线）。 */
export const FONT_WHITELIST = {
  system: '-apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", SimSun, serif',
  mono: '"SF Mono", Consolas, "Courier New", monospace',
} as const;

export type FontKey = keyof typeof FONT_WHITELIST;

/** 平台默认（13FE §2：平台蓝 #1677ff / 中圆角 / 默认间距）。 */
export const PLATFORM_DEFAULT_THEME: AppTheme = {
  primaryColor: '#1677ff',
  darkMode: false,
  tokens: { borderRadius: 6, spacing: 'default', fontFamily: FONT_WHITELIST.system },
};

const BORDER_RADII: readonly number[] = [4, 6, 8];
const SPACINGS: readonly string[] = ['compact', 'default', 'loose'];
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export interface ValidateResult {
  ok: boolean;
  value?: AppTheme;
  /** 非法字段错误清单（保存按钮态联动 + 后端二次校验对齐的可观察错误）。 */
  errors: string[];
}

/**
 * AppTheme 白名单校验（前端预校验——后端应用服务保存链路同判）：
 * - 顶层只接受 primaryColor/darkMode/tokens；未知键拒绝；
 * - primaryColor 须匹配 hex 正则（#rgb / #rrggbb）；darkMode 须为 boolean；
 * - tokens.fontFamily 须在白名单枚举内；borderRadius ∈ {4,6,8}；spacing ∈ 三档；
 * - 非法字段记录错误并剔除（部分合法仍产出 value——调用方决定整体拒或降级）。
 */
export function validateAppTheme(input: unknown): ValidateResult {
  const errors: string[] = [];
  if (input == null) return { ok: true, value: {}, errors };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['theme 必须为对象'] };
  }
  const src = input as Record<string, unknown>;
  const out: AppTheme = {};
  const KNOWN = ['primaryColor', 'darkMode', 'tokens'] as const;
  for (const key of Object.keys(src)) {
    if (!(KNOWN as readonly string[]).includes(key)) {
      errors.push(`未知键: ${key}`);
    }
  }
  if ('primaryColor' in src) {
    const v = src.primaryColor;
    if (typeof v !== 'string' || !HEX_RE.test(v)) {
      errors.push(`primaryColor 非法（须 #rgb/#rrggbb）: ${String(v)}`);
    } else {
      out.primaryColor = v.toLowerCase();
    }
  }
  if ('darkMode' in src) {
    const v = src.darkMode;
    if (typeof v !== 'boolean') {
      errors.push(`darkMode 须为 boolean: ${String(v)}`);
    } else {
      out.darkMode = v;
    }
  }
  if ('tokens' in src) {
    const t = src.tokens;
    if (typeof t !== 'object' || t === null || Array.isArray(t)) {
      errors.push('tokens 须为对象');
    } else {
      const tk = t as Record<string, unknown>;
      const outTokens: AppThemeTokens = {};
      const KNOWN_T = ['fontFamily', 'borderRadius', 'spacing'] as const;
      for (const key of Object.keys(tk)) {
        if (!(KNOWN_T as readonly string[]).includes(key)) {
          errors.push(`tokens 未知键: ${key}`);
        }
      }
      if ('fontFamily' in tk) {
        const v = tk.fontFamily;
        if (typeof v !== 'string' || !Object.prototype.hasOwnProperty.call(FONT_WHITELIST, v)) {
          errors.push(`fontFamily 不在白名单: ${String(v)}`);
        } else {
          outTokens.fontFamily = v;
        }
      }
      if ('borderRadius' in tk) {
        const v = tk.borderRadius;
        if (typeof v !== 'number' || !BORDER_RADII.includes(v)) {
          errors.push(`borderRadius 须为 4|6|8: ${String(v)}`);
        } else {
          outTokens.borderRadius = v as 4 | 6 | 8;
        }
      }
      if ('spacing' in tk) {
        const v = tk.spacing;
        if (typeof v !== 'string' || !SPACINGS.includes(v)) {
          errors.push(`spacing 须为 compact|default|loose: ${String(v)}`);
        } else {
          outTokens.spacing = v as AppThemeTokens['spacing'];
        }
      }
      if (Object.keys(outTokens).length > 0) out.tokens = outTokens;
    }
  }
  return { ok: errors.length === 0, value: errors.length === 0 ? out : undefined, errors };
}

/**
 * 生效 token 解析（两层继承：平台默认 → 应用覆盖）：
 * 非法/缺失字段静默回退默认（A5 兼容红线——旧应用无 theme 行为与升级前一致）；
 * 应用配置中的非法字段被 validateAppTheme 剔除后不参与覆盖。
 */
export function resolve(theme?: AppTheme | null): ThemeTokens {
  const base: ThemeTokens = {
    colorPrimary: PLATFORM_DEFAULT_THEME.primaryColor!,
    borderRadius: PLATFORM_DEFAULT_THEME.tokens!.borderRadius!,
    fontFamily: PLATFORM_DEFAULT_THEME.tokens!.fontFamily!,
    spacing: PLATFORM_DEFAULT_THEME.tokens!.spacing!,
    darkMode: PLATFORM_DEFAULT_THEME.darkMode!,
  };
  if (!theme) return base;
  const checked = validateAppTheme(theme);
  if (!checked.ok || !checked.value) return base;
  const v = checked.value;
  return {
    colorPrimary: v.primaryColor ?? base.colorPrimary,
    darkMode: v.darkMode ?? base.darkMode,
    borderRadius: v.tokens?.borderRadius ?? base.borderRadius,
    fontFamily: v.tokens?.fontFamily ? FONT_WHITELIST[v.tokens.fontFamily as FontKey] : base.fontFamily,
    spacing: v.tokens?.spacing ?? base.spacing,
  };
}

/**
 * resolve 的可观察版本（spec 019 §8：非法存量主题不能只有静默默认回退）：
 * 返回生效 token + 校验错误清单（空 = 合法或无配置）——消费方据此展示可观察反馈，
 * 如 runtime 顶部黄条「主题配置非法已按平台默认渲染（错误明细）」。
 */
export function resolveWithReport(theme?: AppTheme | null): { tokens: ThemeTokens; errors: string[] } {
  const tokens = resolve(theme);
  const errors = theme == null ? [] : validateAppTheme(theme).errors;
  return { tokens, errors };
}

export function spacingPixels(spacing: ThemeTokens['spacing']): number {
  return spacing === 'compact' ? 8 : spacing === 'loose' ? 24 : 16;
}

/** ThemeTokens → CSS 变量集（--schema-* 前缀；运行时挂 documentElement，卸载恢复由消费方负责）。 */
export function cssVarsOf(t: ThemeTokens): Record<string, string> {
  return {
    '--schema-primary': t.colorPrimary,
    '--schema-radius': `${t.borderRadius}px`,
    '--schema-font': t.fontFamily,
    '--schema-spacing': `${spacingPixels(t.spacing)}px`,
    '--schema-dark': t.darkMode ? '1' : '0',
    // 暗色壳层背景/前景（AppShell 原生 div 不走 antd Layout——由变量驱动跟随暗色）
    '--schema-bg': t.darkMode ? '#141414' : '#ffffff',
    '--schema-bg-layout': t.darkMode ? '#000000' : '#ffffff',
    '--schema-fg': t.darkMode ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.88)',
    '--schema-border': t.darkMode ? 'rgba(255,255,255,0.12)' : '#eee',
  };
}

/**
 * AntD ConfigProvider theme 适配参数（spec 019 §3.1 antdTokenOf——映射唯一定义点）：
 * 算法标识（dark/light）+ token 面，供消费方装配 `theme={{ algorithm, token }}`。
 * 本包不依赖 antd——算法常量分派（antdTheme.darkAlgorithm 等）在消费方接线，
 * 预览与 runtime 必须消费本函数，禁止各自手拼映射（防再次漂移）。
 */
export interface AntdThemeSpec {
  dark: boolean;
  token: {
    colorPrimary: string;
    borderRadius: 4 | 6 | 8;
    fontFamily: string;
    padding: number;
  };
}

export function antdTokenOf(t: ThemeTokens): AntdThemeSpec {
  return {
    dark: t.darkMode,
    token: {
      colorPrimary: t.colorPrimary,
      borderRadius: t.borderRadius,
      fontFamily: t.fontFamily,
      padding: spacingPixels(t.spacing),
    },
  };
}
