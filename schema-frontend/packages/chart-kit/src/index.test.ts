import { describe, expect, it } from 'vitest';
import { axisOption, metricValue, isChartDs, type AggRow } from './index';

describe('isChartDs 结构判定', () => {
  it('合法 ChartDs（模型 + measures）', () => {
    expect(isChartDs({
      modelId: 'm1',
      aggregate: { measures: [{ fieldKey: 'amount', func: 'SUM' }] },
    })).toBe(true);
  });
  it('缺 modelId / measures 空数组 / 非对象一律拒绝', () => {
    expect(isChartDs(null)).toBe(false);
    expect(isChartDs('x')).toBe(false);
    expect(isChartDs({ aggregate: { measures: [{ fieldKey: 'a', func: 'COUNT' }] } })).toBe(false);
    expect(isChartDs({ modelId: 'm1', aggregate: { measures: [] } })).toBe(false);
    expect(isChartDs({ modelId: 'm1', aggregate: { measures: [{ func: 'COUNT' }] } })).toBe(false);
  });
});

describe('metricValue 指标卡取值', () => {
  it('首行首度量值', () => {
    const rows: AggRow[] = [{ values: [{ func: 'SUM', fieldKey: 'amount', value: 1234.5 }] }];
    expect(metricValue(rows)).toBe(1234.5);
  });
  it('空结果/非数值返回 null（渲染侧显示 0 占位）', () => {
    expect(metricValue([])).toBe(null);
    expect(metricValue([{ values: [{ func: 'SUM', fieldKey: 'x', value: null }] }])).toBe(null);
  });
});

describe('axisOption 轴图映射', () => {
  const grouped: AggRow[] = [
    { dimension: '差旅', values: [{ func: 'SUM', fieldKey: 'amount', value: 300 }] },
    { dimension: '餐饮', values: [{ func: 'SUM', fieldKey: 'amount', value: 120 }] },
  ];

  it('分组聚合 → xAxis=dimension，series 按度量', () => {
    const opt = axisOption('bar', grouped, '费用分布');
    expect((opt.xAxis as { data: string[] }).data).toEqual(['差旅', '餐饮']);
    const series = opt.series as { name: string; type: string; data: (number | null)[] }[];
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ name: 'SUM(amount)', type: 'bar', data: [300, 120] });
  });

  it('时间桶聚合 → bucket 作类目轴（后端时序直用）', () => {
    const bucketed: AggRow[] = [
      { bucket: '2026-11-01', values: [{ func: 'COUNT', fieldKey: '__count', value: 4 }] },
      { bucket: '2026-11-02', values: [{ func: 'COUNT', fieldKey: '__count', value: 9 }] },
    ];
    const opt = axisOption('line', bucketed);
    expect((opt.xAxis as { data: string[] }).data).toEqual(['2026-11-01', '2026-11-02']);
    expect((opt.series as { type: string }[])[0].type).toBe('line');
  });

  it('无维度聚合 → 单类目「全部」承载单值', () => {
    const total: AggRow[] = [{ values: [{ func: 'COUNT', fieldKey: '__count', value: 42 }] }];
    const opt = axisOption('bar', total);
    expect((opt.xAxis as { data: string[] }).data).toEqual(['全部']);
    expect((opt.series as { data: number[] }[])[0].data).toEqual([42]);
  });

  it('多度量 → 每度量一条 series，缺值补 null', () => {
    const multi: AggRow[] = [
      { dimension: 'A', values: [
        { func: 'SUM', fieldKey: 'amount', value: 10 },
        { func: 'COUNT', fieldKey: '__count', value: 2 },
      ] },
      { dimension: 'B', values: [
        { func: 'SUM', fieldKey: 'amount', value: 5 },
        { func: 'COUNT', fieldKey: '__count', value: null },
      ] },
    ];
    const opt = axisOption('bar', multi);
    const series = opt.series as { name: string; data: (number | null)[] }[];
    expect(series).toHaveLength(2);
    expect(series[1].data).toEqual([2, null]);
  });
});
