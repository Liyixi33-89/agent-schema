import { describe, expect, it } from 'vitest';
import { layeredLayout, extractRelationEdges } from '../src/protocol';

/** M12 收口回归：分层布局与关系边提取（画布 0 边缺陷的协议层验证）。 */
describe('layeredLayout 关系驱动分层（M12 收口回归）', () => {
  const models = Array.from({ length: 73 }, (_, i) => ({ id: String(34 + i) }));

  it('无边输入退化单行（已知行为——重排兜底依赖 CANVAS_LIMIT 防御）', () => {
    const pos = layeredLayout(models, []);
    const ys = new Set(Object.values(pos).map((p) => p.y));
    expect(ys.size).toBe(1);
  });

  it('链式关系必须分层：99→100→…→105 链节点 y 坐标多层分布', () => {
    const edges = Array.from({ length: 19 }, (_, i) => ({
      sourceModelId: String(87 + i), sourceFieldKey: 'rel_target',
      targetModelId: String(86 + i), cardinality: '1:n',
    }));
    const pos = layeredLayout(models, edges);
    const chainY = new Set(['99', '100', '101', '102', '103', '104', '105'].map((id) => pos[id]?.y));
    expect(chainY.size).toBeGreaterThanOrEqual(5);   // 链深度 6+ 应明显分层
  });

  it('自关联（84→84）不产生无限分层', () => {
    const edges = [{ sourceModelId: '84', sourceFieldKey: 'rel_target', targetModelId: '84', cardinality: '1:n' }];
    const pos = layeredLayout(models, edges);
    expect(pos['84']).toBeDefined();
    expect(Object.keys(pos)).toHaveLength(73);
  });
});

describe('extractRelationEdges 过滤口径（M12 收口回归）', () => {
  it('仅提取 ACTIVE 且带 relation 配置的字段；DELETED/缺配置跳过', () => {
    const edges = extractRelationEdges([
      {
        id: 'm1',
        fields: [
          { fieldKey: 'a', label: 'a', type: 'relation', fieldStatus: 'ACTIVE',
            required: false, uniqueFlag: false, indexed: false, promoteStatus: null, sortOrder: 1, schemaVersion: 1,
            relation: { targetModelId: 'm2', cardinality: '1:n', cascade: 'FORBID' } } as never,
          { fieldKey: 'b', label: 'b', type: 'relation', fieldStatus: 'DELETED',
            required: false, uniqueFlag: false, indexed: false, promoteStatus: null, sortOrder: 2, schemaVersion: 1,
            relation: { targetModelId: 'm2', cardinality: '1:n', cascade: 'FORBID' } } as never,
          { fieldKey: 'c', label: 'c', type: 'relation', fieldStatus: 'ACTIVE',
            required: false, uniqueFlag: false, indexed: false, promoteStatus: null, sortOrder: 3, schemaVersion: 1 } as never,
        ],
      },
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ sourceModelId: 'm1', sourceFieldKey: 'a', targetModelId: 'm2', cardinality: '1:n' });
  });
});
