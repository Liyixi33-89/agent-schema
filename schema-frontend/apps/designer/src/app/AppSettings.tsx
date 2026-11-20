/**
 * 应用设置页签编排（渐进重构第三批——自 main.tsx 原样抽出，行为不变）：
 * 模型 / 页面 / 成员 / 导航 / 主题 / 发布 六页签容器。
 */
import React from 'react';
import { Button, Card, Layout, Space, Tabs, Typography } from 'antd';
import { api, type AppCard } from '../shared/api';
import { statusTag } from './shellShared';
import { ModelTab } from '../features/models';
import { PageDesignerTab } from '../features/pages';
import { FlowTab } from '../features/flows';
import { MembersTab } from '../features/members';
import { NavTab } from '../features/nav';
import { ThemeTab } from '../features/theme';
import { PublishTab } from '../features/publish';

export default function AppSettings({ app, onBack }: { app: AppCard; onBack: () => void }): React.ReactElement {
  return (
    <Layout.Content style={{ padding: 24, maxWidth: 1080, margin: '0 auto', width: '100%' }}>
      <Space style={{ marginBottom: 16 }}>
        <Button onClick={onBack}>← 返回工作台</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>{app.name}</Typography.Title>
        {statusTag(app.status)}
      </Space>
      <Card>
        <Tabs
          items={[
            { key: 'models', label: '模型', children: <ModelTab api={api} appId={app.id} /> },
            { key: 'pages', label: '页面', children: <PageDesignerTab api={api} app={app} /> },
            { key: 'flows', label: '流程', children: <FlowTab /> },
            { key: 'members', label: '成员', children: <MembersTab appId={app.id} /> },
            { key: 'nav', label: '导航', children: <NavTab appId={app.id} /> },
            { key: 'theme', label: '主题', children: <ThemeTab app={app} onBack={onBack} /> },
            { key: 'publish', label: '发布', children: <PublishTab app={app} /> },
          ]}
        />
      </Card>
    </Layout.Content>
  );
}
