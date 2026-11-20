/**
 * 主题装载边界测试（spec 019 收尾核查两项 · 2026-11-20）：
 * - parseTheme 三态：合法对象/JSON 串 → theme；null/空串/缺省 → absent（静默默认，
 *   无警告）；坏 JSON/数组/原始值 → invalid（可观察反馈，不当「无主题」静默吞）。
 * - applyCssVars 恢复语义：写入前记录原值，恢复时精确还原（含「原值空 → removeProperty」
 *   分支）；!important 边界——本函数只承诺恢复内联写入的原值，样式表同名 !important
 *   声明无法被内联覆盖（CSS 优先级铁律）——系统内 --schema-* 仅经本函数内联写入，
 *   边界登记在 spec 019 §7。
 * 测试策略：注入式 style stub（零新增依赖红线——不引 jsdom，同 schema-renderer 测试先例）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type StyleOps = {
  getPropertyValue: (k: string) => string;
  setProperty: (k: string, v: string) => void;
  removeProperty: (k: string) => void;
};

/** 最小 style stub：记录写入/删除操作序列，可预置「页面已有值」。 */
function makeStyleStub(initial: Record<string, string> = {}): StyleOps & { calls: string[]; state: Map<string, string> } {
  const state = new Map<string, string>(Object.entries(initial));
  const calls: string[] = [];
  return {
    calls,
    state,
    getPropertyValue: (k) => state.get(k) ?? '',
    setProperty: (k, v) => { state.set(k, v); calls.push(`set ${k}=${v}`); },
    removeProperty: (k) => { state.delete(k); calls.push(`remove ${k}`); },
  };
}

/** 注入 document stub（恢复真实 document——防跨用例污染）。 */
function stubDocument(style: StyleOps): () => void {
  const real = globalThis.document;
  (globalThis as { document?: unknown }).document = { documentElement: { style } };
  return () => { (globalThis as { document?: unknown }).document = real; };
}

import { applyCssVars, parseTheme } from './AppThemeProvider';

describe('parseTheme 三态（坏 JSON 不静默当无主题）', () => {
  it('null / undefined / 空白串 → absent（无主题，静默默认无警告）', () => {
    expect(parseTheme(null)).toEqual({ kind: 'absent' });
    expect(parseTheme(undefined)).toEqual({ kind: 'absent' });
    expect(parseTheme('')).toEqual({ kind: 'absent' });
    expect(parseTheme('   ')).toEqual({ kind: 'absent' });
  });
  it('合法 JSON 串 → theme', () => {
    const r = parseTheme('{"primaryColor":"#f5222d","darkMode":true}');
    expect(r.kind).toBe('theme');
    expect(r.kind === 'theme' && r.value.primaryColor).toBe('#f5222d');
  });
  it('对象直传 → theme（宽松 Jackson 口径）', () => {
    const r = parseTheme({ darkMode: true });
    expect(r.kind).toBe('theme');
  });
  it('坏 JSON 串 → invalid（携带解析失败明细——可观察反馈判据）', () => {
    const r = parseTheme('{"primaryColor": "#f52');   // 截断 JSON
    expect(r.kind).toBe('invalid');
    expect(r.kind === 'invalid' && r.reason).toContain('theme JSON 解析失败');
  });
  it('数组 / 原始值 → invalid', () => {
    expect(parseTheme(['#f5222d']).kind).toBe('invalid');
    expect(parseTheme(42).kind).toBe('invalid');
    expect(parseTheme(true).kind).toBe('invalid');
  });
});

describe('applyCssVars 恢复语义（记录原值精确还原）', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('全新变量：写入后恢复 = removeProperty（不留残留空串）', () => {
    const style = makeStyleStub();
    const restore = stubDocument(style);
    try {
      const undo = applyCssVars({ '--schema-primary': '#1677ff' });
      expect(style.state.get('--schema-primary')).toBe('#1677ff');
      undo();
      expect(style.state.has('--schema-primary')).toBe(false);
      expect(style.calls).toEqual([
        'set --schema-primary=#1677ff',
        'remove --schema-primary',
      ]);
    } finally { restore(); }
  });

  it('页面已有值：恢复还原为原值（非删除）', () => {
    const style = makeStyleStub({ '--schema-bg': '#ffffff', '--schema-dark': '0' });
    const restore = stubDocument(style);
    try {
      const undo = applyCssVars({ '--schema-bg': '#141414', '--schema-dark': '1' });
      expect(style.state.get('--schema-bg')).toBe('#141414');
      undo();
      expect(style.state.get('--schema-bg')).toBe('#ffffff');
      expect(style.state.get('--schema-dark')).toBe('0');
    } finally { restore(); }
  });

  it('连续两轮应用（切换场景）：第二轮恢复还原第一轮写入值', () => {
    const style = makeStyleStub();
    const restore = stubDocument(style);
    try {
      const undoA = applyCssVars({ '--schema-primary': '#1677ff' });
      const undoB = applyCssVars({ '--schema-primary': '#f5222d' });
      expect(style.state.get('--schema-primary')).toBe('#f5222d');
      undoB();
      expect(style.state.get('--schema-primary')).toBe('#1677ff');   // 回到 A 应用值
      undoA();
      expect(style.state.has('--schema-primary')).toBe(false);       // 最终清空
    } finally { restore(); }
  });

  it('恢复函数可重复调用（幂等——卸载清理竞态兜底）', () => {
    const style = makeStyleStub({ '--schema-dark': '0' });
    const restore = stubDocument(style);
    try {
      const undo = applyCssVars({ '--schema-dark': '1' });
      undo();
      undo();   // 二次恢复不抛异常、不破坏已还原状态
      expect(style.state.get('--schema-dark')).toBe('0');
    } finally { restore(); }
  });
});
