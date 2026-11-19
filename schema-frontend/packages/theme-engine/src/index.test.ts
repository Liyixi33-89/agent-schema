import { describe, expect, it } from 'vitest';
import {
  FONT_WHITELIST, PLATFORM_DEFAULT_THEME, antdTokenOf, cssVarsOf, resolve, resolveWithReport, validateAppTheme,
} from './index';

describe('validateAppTheme 白名单封闭集合', () => {
  it('空输入合法（旧应用无 theme）', () => {
    const r = validateAppTheme(null);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({});
  });

  it('合法完整配置通过并归一化 hex 小写', () => {
    const r = validateAppTheme({
      primaryColor: '#1AB394',
      darkMode: true,
      tokens: { fontFamily: 'serif', borderRadius: 8, spacing: 'loose' },
    });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({
      primaryColor: '#1ab394',
      darkMode: true,
      tokens: { fontFamily: 'serif', borderRadius: 8, spacing: 'loose' },
    });
  });

  it('未知顶层键拒绝', () => {
    const r = validateAppTheme({ primaryColor: '#1677ff', customCss: 'body{}' });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('未知键: customCss');
  });

  it('tokens 未知键拒绝（防 token 面积失控）', () => {
    const r = validateAppTheme({ tokens: { logoFileId: 'x', borderRadius: 4 } });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('tokens 未知键: logoFileId');
  });

  it('非法 hex 拒绝', () => {
    for (const bad of ['#1677', '1677ff', '#gggggg', 'rgb(1,2,3)', '#12345']) {
      expect(validateAppTheme({ primaryColor: bad }).ok).toBe(false);
    }
  });

  it('3 位 hex 合法', () => {
    expect(validateAppTheme({ primaryColor: '#0a0' }).ok).toBe(true);
  });

  it('darkMode 非 boolean 拒绝', () => {
    expect(validateAppTheme({ darkMode: 'yes' }).ok).toBe(false);
  });

  it('borderRadius 枚举外拒绝', () => {
    expect(validateAppTheme({ tokens: { borderRadius: 12 } }).ok).toBe(false);
    expect(validateAppTheme({ tokens: { borderRadius: 2 } }).ok).toBe(false);
  });

  it('fontFamily 白名单外拒绝（非任意 URL）', () => {
    expect(validateAppTheme({ tokens: { fontFamily: 'http://evil/font.woff' } }).ok).toBe(false);
    expect(validateAppTheme({ tokens: { fontFamily: 'system' } }).ok).toBe(true);
  });

  it('spacing 枚举外拒绝', () => {
    expect(validateAppTheme({ tokens: { spacing: 'huge' } }).ok).toBe(false);
  });

  it('数组/字符串形态整体拒绝', () => {
    expect(validateAppTheme([]).ok).toBe(false);
    expect(validateAppTheme('blue').ok).toBe(false);
  });
});

describe('resolve 两层继承与降级', () => {
  it('无 theme → 平台默认', () => {
    expect(resolve(null)).toEqual({
      colorPrimary: '#1677ff',
      borderRadius: 6,
      fontFamily: FONT_WHITELIST.system,
      spacing: 'default',
      darkMode: false,
    });
  });

  it('应用覆盖逐字段生效（未配置字段保持默认）', () => {
    const t = resolve({ primaryColor: '#52c41a', tokens: { borderRadius: 4 } });
    expect(t.colorPrimary).toBe('#52c41a');
    expect(t.borderRadius).toBe(4);
    expect(t.spacing).toBe('default');
    expect(t.darkMode).toBe(false);
  });

  it('非法字段静默回退默认（A5 兼容红线——非法存量不炸装载）', () => {
    const t = resolve({ primaryColor: 'javascript:alert(1)', tokens: { borderRadius: 99 as unknown as 8 } });
    expect(t.colorPrimary).toBe('#1677ff');
    expect(t.borderRadius).toBe(6);
  });

  it('PLATFORM_DEFAULT_THEME 自身可空转 resolve', () => {
    expect(resolve(PLATFORM_DEFAULT_THEME)).toEqual(resolve(null));
  });
});

describe('cssVarsOf', () => {
  it('产出 --schema-* 变量集', () => {
    const vars = cssVarsOf(resolve({ darkMode: true, tokens: { borderRadius: 8 } }));
    expect(vars['--schema-primary']).toBe('#1677ff');
    expect(vars['--schema-radius']).toBe('8px');
    expect(vars['--schema-dark']).toBe('1');
    expect(Object.keys(vars).every((k) => k.startsWith('--schema-'))).toBe(true);
  });
});

describe('主题审查缺陷回归', () => {
  it('拒绝原型链字体名、数字字符串和字段空值', () => {
    for (const input of [
      { tokens: { fontFamily: 'constructor' } },
      { tokens: { fontFamily: 'toString' } },
      { tokens: { borderRadius: '6' } },
      { tokens: null }, { darkMode: 'false' }, { darkMode: null },
    ]) expect(validateAppTheme(input).ok).toBe(false);
  });
  it('字体键统一解析为实际字体栈', () => {
    expect(resolve({ tokens: { fontFamily: 'mono' } }).fontFamily).toBe(FONT_WHITELIST.mono);
    expect(resolve({ tokens: { fontFamily: 'serif' } }).fontFamily).toBe(FONT_WHITELIST.serif);
  });
});

describe('antdTokenOf 唯一映射点（预览与 runtime 共用）', () => {
  it('产出生效 token 面（colorPrimary/borderRadius/fontFamily/padding）与算法标识', () => {
    const spec = antdTokenOf(resolve({ primaryColor: '#52c41a', darkMode: true, tokens: { borderRadius: 8, spacing: 'loose' } }));
    expect(spec.dark).toBe(true);
    expect(spec.token).toEqual({
      colorPrimary: '#52c41a', borderRadius: 8,
      fontFamily: FONT_WHITELIST.system, padding: 24,
    });
  });
  it('亮色默认档映射', () => {
    const spec = antdTokenOf(resolve(null));
    expect(spec.dark).toBe(false);
    expect(spec.token.padding).toBe(16);
    expect(spec.token.borderRadius).toBe(6);
  });
});

describe('resolveWithReport 非法存量可观察反馈（spec 019 §8）', () => {
  it('合法/无配置 → 空 errors', () => {
    expect(resolveWithReport(null).errors).toEqual([]);
    expect(resolveWithReport({ primaryColor: '#52c41a' }).errors).toEqual([]);
  });
  it('非法存量 → 降级平台默认 + 错误清单透出（不静默）', () => {
    const { tokens, errors } = resolveWithReport({ primaryColor: 'javascript:alert(1)', tokens: { borderRadius: 99 as unknown as 8 } });
    expect(tokens.colorPrimary).toBe('#1677ff');
    expect(tokens.borderRadius).toBe(6);
    expect(errors.join('；')).toContain('primaryColor');
    expect(errors.join('；')).toContain('borderRadius');
  });
});
