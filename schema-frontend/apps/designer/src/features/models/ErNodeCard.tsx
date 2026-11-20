/**
 * ER 画布节点卡与边样式（10FE §1.2——自 ErCanvas.tsx 原样抽出，行为不变）：
 * - ModelNodeCard：自定义节点（标题栏 + 字段列表预览 + 编辑入口）
 * - nodeTypes/edgeStyle：React Flow 注册表与关系边样式协议
 */
import React from 'react';
import {
  Handle, Position,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import { Button, Space, Tag, Typography } from 'antd';
import type { ModelSummary } from '../../shared/api';
import type { ModelField } from '@schema/data-model-designer';

/** 节点数据（宿主注入——summary/fields/onOpenEditor）。 */
export type ModelNodeData = {
  summary: ModelSummary;
  fields: (ModelField & { _deleted?: boolean })[];
  activeCount: number;
  onOpenEditor: (id: string) => void;
};

export function ModelNodeCard({ data, selected }: NodeProps<Node<ModelNodeData>>): React.ReactElement {
  const { summary, fields, activeCount, onOpenEditor } = data;
  const visible = fields.filter((f) => f.fieldStatus === 'ACTIVE').slice(0, 5);
  // React Flow 边渲染锚点：无 Handle 则边不绘制（本缺陷曾致 0 边——props 有 19 条边但 DOM 0 条）
  const handleStyle = { width: 7, height: 7, background: '#1677ff', border: '1px solid #fff' };
  return (
    <div className="er-node" style={{
      width: 300, background: '#fff', borderRadius: 8,
      border: `1px solid ${selected ? '#1677ff' : '#d9d9d9'}`,
      boxShadow: selected ? '0 0 0 2px rgba(22,119,255,.15)' : '0 2px 8px rgba(0,0,0,.06)',
    }}>
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <div className="er-node-header" style={{
        padding: '8px 12px', borderBottom: '1px solid #f0f0f0', background: selected ? '#e6f4ff' : '#fafafa',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <Typography.Text strong ellipsis style={{ maxWidth: 96 }}>{summary.name}</Typography.Text>
        <Space size={4}>
          <Tag style={{ marginInlineEnd: 0, fontSize: 10 }}>{summary.modelKey}</Tag>
          <Tag color="blue" style={{ marginInlineEnd: 0 }}>v{summary.currentVersion}</Tag>
        </Space>
      </div>
      <div className="er-node-body" style={{ padding: '4px 12px 8px' }}>
        {fields.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '28px' }}>加载中…</Typography.Text>
        ) : visible.map((f) => (
          <div key={f.fieldKey} style={{
            display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '2px 0',
            opacity: f._deleted ? 0.45 : 1, textDecoration: f._deleted ? 'line-through' : 'none',
          }}>
            <span>{f.label || f.fieldKey}</span>
            <span style={{ color: '#8c8c8c' }}>{f.type}{f.required ? ' *' : ''}</span>
          </div>
        ))}
        {activeCount > 5 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>… 共 {activeCount} 个字段</Typography.Text>
        )}
        <Button block size="small" style={{ marginTop: 6 }} onClick={() => onOpenEditor(summary.id)}>
          编辑字段
        </Button>
      </div>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}

export const nodeTypes = { model: ModelNodeCard };

/** 关系边样式协议：1:1 实线 / 1:n 燕尾 / n:n 虚线（10FE §1.2）。 */
export function edgeStyle(cardinality: string): Pick<Edge, 'animated' | 'style' | 'label'> {
  if (cardinality === 'n:n') return { animated: false, style: { stroke: '#1677ff', strokeDasharray: '6 3' } };
  if (cardinality === '1:1') return { animated: false, style: { stroke: '#595959' } };
  return { animated: false, style: { stroke: '#1677ff' } };
}
