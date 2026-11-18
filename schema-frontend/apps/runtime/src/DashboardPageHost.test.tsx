import { describe, expect, it } from 'vitest';
import { collectChartNodes } from './DashboardPageHost';
import type { PageSchema, LayoutNode } from '@schema/schema-protocol';
import { CHART_MATERIALS, registerChartMaterials, isChartDs } from '@schema/component-materials';
import { materialRegistry } from '@schema/schema-renderer';

describe('collectChartNodes 图表节点收集', () => {
  it('嵌套树中按物料组 + ChartDs 判定收集（无 dataSource 节点不触发装载）', () => {
    registerChartMaterials(materialRegistry);
    const node = (componentName: string, props: Record<string, unknown> = {}): LayoutNode =>
      ({ id: componentName, componentName, props: props as never });
    const chartDs = {
      modelId: 'm1',
      aggregate: { measures: [{ fieldKey: 'amount', func: 'SUM' }], group: { fieldKey: 'type' } },
    };
    const page = {
      id: 'p1', pageKey: 'dash', name: '仪表盘', type: 'DASHBOARD',
      path: '/dash', layout: [
        node('MetricCard', { dataSource: chartDs }),
        node('SectionCard'),
        {
          ...node('SectionCard'),
          children: [
            node('BarChart', { dataSource: chartDs }),
            node('BarChart'), // 图表物料但未配置数据源——收集排除（渲染占位）
            node('LineChart', { dataSource: { modelId: 'm1', aggregate: { measures: [] } } }), // 结构非法排除
          ],
        },
      ],
      actions: [], schemaVersion: 1,
    } as unknown as PageSchema;

    const out = collectChartNodes(page.layout);
    expect(out.map((n) => n.id)).toEqual(['MetricCard', 'BarChart']);
  });
});

describe('图表物料注册表', () => {
  it('三物料注册且组件可解析', () => {
    registerChartMaterials(materialRegistry);
    const names = CHART_MATERIALS.map((m) => m.componentName).sort();
    expect(names).toEqual(['BarChart', 'LineChart', 'MetricCard']);
    for (const n of names) {
      const meta = materialRegistry.get(n);
      expect(meta?.group).toBe('图表');
      expect(typeof meta?.component).toBe('function');
    }
  });
});

describe('isChartDs 与发布兼容', () => {
  it('ChartDs 通过判定（协议 props 静态 JSON 合法面内）', () => {
    expect(isChartDs({
      modelId: 'm2',
      aggregate: {
        measures: [{ fieldKey: 'amount', func: 'SUM' }],
        timeBucket: { fieldKey: 'created', interval: 'DAY' },
      },
      filter: { and: [
        { field: 'created', op: 'gte', value: '2026-11-01' },
        { field: 'created', op: 'lte', value: '2026-11-30' },
      ] },
    })).toBe(true);
  });
});
