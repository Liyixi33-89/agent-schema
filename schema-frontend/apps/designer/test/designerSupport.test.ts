import { describe, expect, it } from 'vitest';
import type { LayoutNode } from '@schema/schema-protocol';
import { materialRegistry } from '@schema/schema-renderer';
import { ensureMaterials, findParentId } from '../src/features/pages/designerSupport';

const node = (id: string, children?: LayoutNode[]): LayoutNode => ({
  id, componentName: 'SectionCard', props: {}, ...(children ? { children } : {}),
});

describe('设计器生产装配辅助逻辑', () => {
  it('基本与图表物料真实登记，重复初始化不移除已有物料', () => {
    ensureMaterials();
    const first = materialRegistry.get('LabelText');
    expect(first).toBeDefined();
    expect(materialRegistry.get('BarChart')).toBeDefined();
    ensureMaterials();
    expect(materialRegistry.get('LabelText')).toBe(first);
  });
  it('移动命令定位实际嵌套容器数组，根数组返回 null', () => {
    const inner = [node('leaf')];
    const outer = [node('inner', inner)];
    const layout = [node('outer', outer)];
    expect(findParentId(layout, inner)).toBe('inner');
    expect(findParentId(layout, outer)).toBe('outer');
    expect(findParentId(layout, layout)).toBeNull();
    expect(findParentId(layout, [...inner])).toBeNull();
  });
});
