/**
 * 设计器属性面板（propsSchema 自动生成）与 409 三方差异摘要
 * ——自 PageDesignerTab.tsx 原样抽出，行为不变。
 */
import React from 'react';
import {
  Alert, Button, Form, Input, List, Radio, Select, Space, Switch, Typography,
} from 'antd';
import type { FieldSchema, LayoutNode, PageSchema, PropValue } from '@schema/schema-protocol';
import { checkPanelExpr, type PropFieldSchema } from '@schema/page-designer';

// ---------- 属性面板（propsSchema 自动生成） ----------

/** 图表数据源配置面板（spec 017）：模型 + 度量 + 分组/时间桶——嵌套 dataSource 专用渲染。 */
export function ChartDsPanel({ node, models, dsFields, onLoadModelFields, onChange }: {
  node: LayoutNode;
  models: { value: string; label: string }[];
  /** 当前数据源模型字段（onLoadModelFields 异步装载缓存）。 */
  dsFields: FieldSchema[];
  onLoadModelFields: (modelId: string) => void;
  onChange: (patch: Record<string, PropValue>) => void;
}): React.ReactElement {
  const ds = (node.props.dataSource ?? null) as {
    modelId?: string;
    aggregate?: {
      measures?: { fieldKey: string; func: string }[];
      group?: { fieldKey: string; topN?: number };
      timeBucket?: { fieldKey: string; interval: string };
    };
  } | null;
  const agg = ds?.aggregate ?? {};
  const measures = agg.measures ?? [{ fieldKey: '', func: 'COUNT' }];
  const patch = (next: NonNullable<typeof ds>): void => onChange({ dataSource: next });
  const fieldOptions = dsFields
    .filter((f) => f.fieldStatus === 'ACTIVE')
    .map((f) => ({ value: f.key, label: `${f.label} (${f.key})` }));
  const bucketFields = dsFields
    .filter((f) => f.fieldStatus === 'ACTIVE' && f.type === 'date')
    .map((f) => ({ value: f.key, label: `${f.label} (${f.key})` }));

  return (
    <div>
      <Typography.Text strong style={{ fontSize: 13 }}>数据源（模型聚合）</Typography.Text>
      <Form.Item label="模型">
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          value={ds?.modelId}
          options={models}
          placeholder="选择数据模型"
          onChange={(v) => {
            if (!v) { patch({ modelId: '', aggregate: { measures: [{ fieldKey: '', func: 'COUNT' }] } }); return; }
            onLoadModelFields(v);
            patch({ modelId: v, aggregate: { measures: [{ fieldKey: '', func: 'COUNT' }] } });
          }}
        />
      </Form.Item>
      {ds?.modelId ? (
        <>
          {measures.map((m, i) => (
            <Form.Item key={i} label={i === 0 ? '度量' : undefined}>
              <Space.Compact style={{ width: '100%' }}>
                <Select
                  style={{ width: '55%' }}
                  value={m.fieldKey || undefined}
                  options={fieldOptions}
                  placeholder="字段"
                  onChange={(v) => {
                    const next = measures.map((x, j) => j === i ? { ...x, fieldKey: v ?? '' } : x);
                    patch({ ...ds, aggregate: { ...agg, measures: next } });
                  }}
                />
                <Select
                  style={{ width: '35%' }}
                  value={m.func}
                  options={['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MAX', 'MIN'].map((f) => ({ value: f, label: f }))}
                  onChange={(v) => {
                    const next = measures.map((x, j) => j === i ? { ...x, func: v } : x);
                    patch({ ...ds, aggregate: { ...agg, measures: next } });
                  }}
                />
                {measures.length > 1 ? (
                  <Button
                    onClick={() => {
                      const next = measures.filter((_, j) => j !== i);
                      patch({ ...ds, aggregate: { ...agg, measures: next } });
                    }}
                  >移除</Button>
                ) : (
                  <Button disabled={measures.length >= 5} onClick={() => {
                    patch({ ...ds, aggregate: { ...agg, measures: [...measures, { fieldKey: '', func: 'COUNT' }] } });
                  }}>添加</Button>
                )}
              </Space.Compact>
            </Form.Item>
          ))}
          <Form.Item label="分组字段（可选）">
            <Select
              allowClear
              value={agg.group?.fieldKey}
              options={fieldOptions}
              placeholder="按字段分组统计"
              onChange={(v) => {
                const next = v ? { ...agg, group: { fieldKey: v, topN: agg.group?.topN ?? 10 } } : { ...agg, group: undefined };
                patch({ ...ds, aggregate: next });
              }}
            />
          </Form.Item>
          <Form.Item label="时间分桶（可选·date 字段）">
            <Select
              allowClear
              value={agg.timeBucket?.fieldKey}
              options={bucketFields}
              placeholder={bucketFields.length ? '按日期字段分桶' : '模型无 date 类型字段'}
              onChange={(v) => {
                const next = v
                  ? { ...agg, timeBucket: { fieldKey: v, interval: agg.timeBucket?.interval ?? 'DAY' } }
                  : { ...agg, timeBucket: undefined };
                patch({ ...ds, aggregate: next });
              }}
            />
          </Form.Item>
          {agg.timeBucket?.fieldKey ? (
            <>
              <Form.Item label="分桶间隔">
                <Radio.Group
                  value={agg.timeBucket.interval ?? 'DAY'}
                  options={['DAY', 'WEEK', 'MONTH'].map((v) => ({ value: v, label: v }))}
                  onChange={(e) => {
                    patch({ ...ds, aggregate: { ...agg, timeBucket: { ...agg.timeBucket!, interval: e.target.value } } });
                  }}
                />
              </Form.Item>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="时间分桶需在发布前为 filter 配置桶字段双边范围（后端护栏：桶数 ≤1000）"
                description={<>运行时聚合请求由宿主携带 <code>filter</code>；本最小版本 filter 需经页面 JSON 直接配置（属性面板编辑器随后续版本交付）。</>}
              />
            </>
          ) : null}
        </>
      ) : (
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
          选择模型后配置度量与分组。
        </Typography.Text>
      )}
    </div>
  );
}

export function PropsPanel({ node, meta, fields, warned, models, dsModelFields, onLoadModelFields, onChange }: {
  node: LayoutNode;
  meta: import('@schema/page-designer').PanelMaterial | undefined;
  fields: FieldSchema[];
  warned: boolean;
  /** 应用模型清单（图表数据源配置）。 */
  models: { value: string; label: string }[];
  /** 图表数据源当前选中模型的字段（按需异步装载）。 */
  dsModelFields: FieldSchema[];
  onLoadModelFields: (modelId: string) => void;
  onChange: (patch: Record<string, PropValue>) => void;
}): React.ReactElement {
  const activeFields = fields.filter((f) => f.fieldStatus === 'ACTIVE');
  const deletedFields = fields.filter((f) => f.fieldStatus === 'DELETED');
  const [exprFeedback, setExprFeedback] = React.useState<Record<string, string>>({});

  const renderField = (f: PropFieldSchema): React.ReactElement => {
    const value = node.props[f.key];
    switch (f.widget) {
      case 'fieldRef':
        return (
          <Form.Item key={f.key} label={f.label} validateStatus={warned ? 'warning' : undefined}>
            <Select
              allowClear
              value={typeof node.fieldRef === 'string' ? node.fieldRef : undefined}
              onChange={(v) => onChange({ fieldRef: v ?? '' })}
              options={[
                ...activeFields.map((fd) => ({ value: fd.key, label: `${fd.label} (${fd.key})` })),
                ...deletedFields.map((fd) => ({ value: fd.key, label: `${fd.label} (${fd.key}) ·已删除`, disabled: true })),
              ]}
              placeholder={fields.length === 0 ? '页面未绑定模型' : '选择字段'}
            />
          </Form.Item>
        );
      case 'switch':
        return (
          <Form.Item key={f.key} label={f.label} valuePropName="checked">
            <Switch checked={!!value} onChange={(v: boolean) => onChange({ [f.key]: v })} />
          </Form.Item>
        );
      case 'expr': {
        const err = exprFeedback[f.key];
        return (
          <Form.Item key={f.key} label={f.label} validateStatus={err ? 'error' : undefined} help={err}>
            <Input
              value={typeof value === 'string' ? value : ''}
              placeholder={f.placeholder}
              status={err ? 'error' : undefined}
              onChange={(e) => {
                const v = e.target.value;
                onChange({ [f.key]: v });
                if (!v.trim()) { setExprFeedback((s) => ({ ...s, [f.key]: '' })); return; }
                const r = checkPanelExpr(v);
                setExprFeedback((s) => ({ ...s, [f.key]: r.ok ? '' : (r.error?.message ?? '表达式错误') }));
              }}
            />
          </Form.Item>
        );
      }
      default:
        return (
          <Form.Item key={f.key} label={f.label}>
            <Input
              value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)}
              onChange={(e) => onChange({ [f.key]: e.target.value })}
            />
          </Form.Item>
        );
    }
  };

  return (
    <div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{node.componentName} · {node.id}</Typography.Text>
      {warned ? <Alert type="warning" showIcon message="该节点引用的字段已删除或不存在（标黄警示）" style={{ margin: '8px 0' }} /> : null}
      {meta?.group === '图表' ? (
        <ChartDsPanel node={node} models={models} dsFields={dsModelFields} onLoadModelFields={onLoadModelFields} onChange={onChange} />
      ) : null}
      {meta?.propsSchema?.length ? (
        meta.propsSchema.map((g) => (
          <div key={g.title}>
            <Typography.Text strong style={{ fontSize: 13 }}>{g.title}</Typography.Text>
            {g.fields.map(renderField)}
          </div>
        ))
      ) : (
        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>该物料暂无可配置属性</Typography.Text>
      )}
    </div>
  );
}

// ---------- 409 三方差异摘要（本地 vs 服务器草稿） ----------

export function ConflictDiff({ baseline, local, server }: { baseline: PageSchema; local: PageSchema; server: PageSchema }): React.ReactElement {
  const flatten = (page: PageSchema): Map<string, unknown> => {
    const values = new Map<string, unknown>();
    const walk = (nodes: LayoutNode[], parentId: string | null): void => {
      nodes.forEach((node, index) => {
        const { children, ...content } = node;
        values.set(node.id, { ...content, parentId, index });
        walk(children ?? [], node.id);
      });
    };
    const { layout, ...pageProps } = page;
    values.set('$page', pageProps);
    walk(layout, null);
    return values;
  };
  const baseValues = flatten(baseline), localValues = flatten(local), serverValues = flatten(server);
  const display = (value: unknown): string => value === undefined ? '不存在（新增/删除）' : JSON.stringify(value);
  const changes = [...new Set([...baseValues.keys(), ...localValues.keys(), ...serverValues.keys()])]
    .filter((id) => display(baseValues.get(id)) !== display(localValues.get(id))
      || display(baseValues.get(id)) !== display(serverValues.get(id)));
  const stats = React.useMemo(() => {
    const count = (nodes: LayoutNode[]): { nodes: number; bound: number } => {
      let n = 0, bound = 0;
      const walk = (arr: LayoutNode[]): void => {
        for (const x of arr) {
          n++;
          if (x.fieldRef) bound++;
          walk(x.children ?? []);
        }
      };
      walk(nodes);
      return { nodes: n, bound };
    };
    const l = count(local.layout ?? []);
    const s = count(server.layout ?? []);
    const exprKeys = ['visibleWhen', 'disabledWhen', 'requiredWhen'];
    const exprCount = (nodes: LayoutNode[]): number => {
      let c = 0;
      const walk = (inner: LayoutNode[]): void => {
        for (const x of inner) {
          for (const k of exprKeys) if (typeof x.props?.[k] === 'string' && (x.props[k] as string).trim()) c++;
          walk(x.children ?? []);
        }
      };
      walk(nodes);
      return c;
    };
    return {
      local: { ...l, expr: exprCount(local.layout ?? []) },
      server: { ...s, expr: exprCount(server.layout ?? []) },
    };
  }, [local, server]);
  return (
    <div style={{ marginTop: 12 }}>
      <Typography.Text strong style={{ fontSize: 13 }}>三方内容差异（不自动合并）</Typography.Text>
      <List dataSource={changes} renderItem={(id) => (
        <List.Item key={id}>
          <Space direction="vertical">
            <Typography.Text strong>{id === '$page' ? '页面属性' : `节点 ${id}`}</Typography.Text>
            <Typography.Text>编辑基线：{display(baseValues.get(id))}</Typography.Text>
            <Typography.Text>本地草稿：{display(localValues.get(id))}</Typography.Text>
            <Typography.Text>服务器草稿：{display(serverValues.get(id))}</Typography.Text>
          </Space>
        </List.Item>
      )} />
      <table style={{ width: '100%', marginTop: 4, fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>维度</th>
            <th style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>本地（保留中）</th>
            <th style={{ textAlign: 'right', borderBottom: '1px solid #eee' }}>服务器 v{String(server.schemaVersion ?? '?')}</th>
          </tr>
        </thead>
        <tbody>
          <tr><td style={{ padding: '2px 0' }}>节点数</td><td style={{ textAlign: 'right' }}>{stats.local.nodes}</td><td style={{ textAlign: 'right' }}>{stats.server.nodes}</td></tr>
          <tr><td style={{ padding: '2px 0' }}>字段绑定数</td><td style={{ textAlign: 'right' }}>{stats.local.bound}</td><td style={{ textAlign: 'right' }}>{stats.server.bound}</td></tr>
          <tr><td style={{ padding: '2px 0' }}>联动表达式数</td><td style={{ textAlign: 'right' }}>{stats.local.expr}</td><td style={{ textAlign: 'right' }}>{stats.server.expr}</td></tr>
        </tbody>
      </table>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        稍后处理不会更新版本；准备替换只更新基线，需手动保存；放弃会重新获取服务器草稿。
      </Typography.Text>
    </div>
  );
}

