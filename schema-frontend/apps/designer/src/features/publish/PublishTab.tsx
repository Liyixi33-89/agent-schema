/**
 * 发布页签（渐进重构第三批——自 main.tsx 原样抽出，行为不变）：
 * 发布生成应用级快照（不可变）；运行时按 ETag 缓存读取。
 */
import React from 'react';
import { Button, List, message, Space, Tag, Typography } from 'antd';
import { api, type AppCard, type ReleaseRow } from '../../shared/api';
import { handleError } from '../../app/shellShared';

export default function PublishTab({ app }: { app: AppCard }): React.ReactElement {
  const [releases, setReleases] = React.useState<ReleaseRow[] | null>(null);
  const [publishing, setPublishing] = React.useState(false);
  const load = React.useCallback(async () => {
    try {
      setReleases((await api.listReleases(app.id)).list);
    } catch (e) { handleError(e); setReleases([]); }
  }, [app.id]);
  React.useEffect(() => { void load(); }, [load]);

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" loading={publishing} onClick={async () => {
          setPublishing(true);
          try {
            await api.publish(app.id);
            message.success('已发布');
            void load();
          } catch (e) { handleError(e); } finally { setPublishing(false); }
        }}>发布全部页面</Button>
        <Typography.Text type="secondary">发布生成应用级快照（不可变）；运行时按 ETag 缓存读取。</Typography.Text>
      </Space>
      <List
        loading={releases === null}
        dataSource={releases ?? []}
        locale={{ emptyText: '暂无发布记录' }}
        renderItem={(r) => (
          <List.Item>
            <Space>
              <Tag color="blue">v{r.version}</Tag>
              <span>操作者 {String(r.operator ?? '-')}</span>
              <Typography.Text type="secondary">{r.releasedAt ?? ''}</Typography.Text>
            </Space>
          </List.Item>
        )}
      />
    </>
  );
}
