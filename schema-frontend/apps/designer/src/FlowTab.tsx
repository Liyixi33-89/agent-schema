/**
 * 流程页签（spec 020 阶段 A · 10FE §2 只读展示）：
 * - 列表态：演示流程清单（契约 Mock——后端 flow-service 属阶段 B，界面标明演示）
 * - 画布态：FlowCanvas 只读渲染（七型节点 + 分支标签 + 未知类型占位）
 * - 分期红线：无新建/编辑/保存/发布入口（spec 020 §2 不做清单）
 * - 输入先过 validateFlowSchema：合法才进画布，非法展示错误列表（不白屏）
 */
import React from 'react';
import { Alert, Button, List, Space, Tag, Typography } from 'antd';
import { SchemaValidationError, validateFlowSchema, type FlowSchema } from '@schema/schema-protocol';
import { FlowCanvas } from '@schema/flow-designer';
import { DEMO_FLOWS } from './flowDemoFixtures';

export default function FlowTab(): React.ReactElement {
  const [viewing, setViewing] = React.useState<FlowSchema | null>(null);

  if (viewing) {
    // 只读画布态：校验拒绝即错误面板（画布只消费合法结构 + 未知类型容错）
    let validationError: string[] | null = null;
    try {
      validateFlowSchema(viewing);
    } catch (e) {
      validationError = e instanceof SchemaValidationError ? e.pointers : [String(e)];
    }
    return (
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space>
            <Button onClick={() => setViewing(null)}>← 返回列表</Button>
            <Typography.Text strong>{viewing.name}</Typography.Text>
            <Tag>{viewing.flowKey}</Tag>
            <Tag color="blue">v{viewing.version}</Tag>
          </Space>
          <Typography.Text type="secondary">只读展示——流程编辑属阶段 B/C（05BE 分期红线）</Typography.Text>
        </Space>
        {validationError ? (
          <Alert type="error" showIcon message="流程 Schema 校验未通过（画布未渲染）" description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>{validationError.map((p) => <li key={p}>{p}</li>)}</ul>
          } />
        ) : (
          <FlowCanvas schema={viewing} />
        )}
      </Space>
    );
  }

  // 列表态：演示 fixture（契约 Mock——阶段 B 后端上线后换真实接口）
  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Alert type="info" showIcon message="阶段 A 只读演示"
        description="当前为契约 Mock 演示数据（后端流程服务属阶段 B）；本页无编辑/保存/发布入口。" />
      <List
        dataSource={DEMO_FLOWS}
        locale={{ emptyText: '暂无流程' }}
        renderItem={(f) => (
          <List.Item actions={[
            <Button key="view" type="link" onClick={() => setViewing(f)}>查看画布</Button>,
          ]}>
            <List.Item.Meta
              title={<Space>{f.name}<Tag>{f.flowKey}</Tag><Tag color="blue">v{f.version}</Tag></Space>}
              description={`${f.nodes.length} 节点 · ${f.edges.length} 连线`}
            />
          </List.Item>
        )}
      />
    </Space>
  );
}
