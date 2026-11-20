/**
 * 导航管理页签（渐进重构第三批——自 main.tsx 原样抽出，行为不变）：
 * 乐观版本控制保存（409 冲突回读）；新增节点三类型 PAGE/LINK/GROUP。
 */
import React from 'react';
import {
  Button, Form, Input, List, message, Modal, Popconfirm, Select, Space, Tag, Typography,
} from 'antd';
import { api, ApiError, type NavNode } from '../../shared/api';
import { handleError } from '../../app/shellShared';

interface FlatNavRow {
  key: string;
  node: NavNode;
  depth: number;
}

function flattenNav(tree: NavNode[], depth = 0, out: FlatNavRow[] = []): FlatNavRow[] {
  for (const n of tree) {
    out.push({ key: n.id, node: n, depth });
    if (n.children?.length) flattenNav(n.children, depth + 1, out);
  }
  return out;
}

export default function NavTab({ appId }: { appId: number }): React.ReactElement {
  const [tree, setTree] = React.useState<NavNode[] | null>(null);
  const [version, setVersion] = React.useState(0);
  const [draft, setDraft] = React.useState<NavNode[]>([]);
  const [dirty, setDirty] = React.useState(false);
  const [pages, setPages] = React.useState<{ id: number; name: string }[]>([]);
  // 新增节点弹层（类型三选：PAGE 引用本应用页面 / LINK 外链 / GROUP 分组）
  const [addOpen, setAddOpen] = React.useState(false);
  const [addForm] = Form.useForm();

  const load = React.useCallback(async () => {
    try {
      const r = await api.getNav(appId);
      setTree(r.tree);
      setVersion(r.version);
      setDraft(r.tree);
      setDirty(false);
    } catch (e) { handleError(e); setTree([]); }
  }, [appId]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    void api.listPages(appId).then((r) => setPages(r.list)).catch(() => setPages([]));
  }, [appId]);

  const rows = flattenNav(draft);

  const move = (idx: number, dir: -1 | 1): void => {
    // 同层平移：简化实现——顶层节点排序（GROUP 内子节点经编辑 JSON 处理，MVP 取舍）
    if (rows[idx].depth !== 0) return;
    const top = [...draft];
    const target = idx + dir;
    if (target < 0 || target >= top.length) return;
    [top[idx], top[target]] = [top[target], top[idx]];
    setDraft(top);
    setDirty(true);
  };

  /** 移除节点（含 GROUP 整枝）；顶层直接过滤，嵌套递归剪枝。 */
  const removeNode = (nodes: NavNode[], id: string): NavNode[] =>
    nodes.filter((n) => n.id !== id).map((n) => (
      n.children?.length ? { ...n, children: removeNode(n.children, id) } : n
    ));

  const genId = (): string => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" disabled={!dirty}
          onClick={async () => {
            try {
              const r = await api.saveNav(appId, draft, version);
              message.success(`导航已保存（v${r.version}）`);
              void load();
            } catch (e) {
              if (e instanceof ApiError && e.code === 'NAV_VERSION_CONFLICT') {
                message.error('版本冲突：他人已更新导航，请刷新后重试');
                void load();
              } else {
                handleError(e);
              }
            }
          }}
        >保存导航</Button>
        <Button onClick={() => { setDraft(tree ?? []); setDirty(false); }}>放弃修改</Button>
        <Button onClick={() => { addForm.resetFields(); setAddOpen(true); }}>新增节点</Button>
        <Typography.Text type="secondary">
          当前版本 v{version}{dirty ? ' · 有未保存修改' : ''}；PAGE 节点须引用本应用页面；保存冲突返回 409。
        </Typography.Text>
      </Space>
      <List
        loading={tree === null}
        dataSource={rows}
        renderItem={(row, idx) => (
          <List.Item
            actions={row.depth === 0 ? ([
              <Button key="up" size="small" disabled={idx === 0} onClick={() => move(idx, -1)}>上移</Button>,
              <Button key="down" size="small" disabled={idx === rows.length - 1} onClick={() => move(idx, 1)}>下移</Button>,
              <Popconfirm
                key="del"
                title="删除该节点？（GROUP 含子节点整枝删除）"
                onConfirm={() => {
                  setDraft(removeNode(draft, row.key));
                  setDirty(true);
                }}
              >
                <Button danger size="small">删除</Button>
              </Popconfirm>,
            ]) : []}
          >
            <Space style={{ paddingLeft: row.depth * 24 }}>
              <Tag>{row.node.type}</Tag>
              <span>{row.node.label}</span>
              {row.node.type === 'PAGE' && <Typography.Text type="secondary">→ 页面 #{row.node.refId}</Typography.Text>}
              {row.node.type === 'LINK' && <Typography.Text type="secondary">{row.node.url}</Typography.Text>}
            </Space>
          </List.Item>
        )}
      />
      <Modal
        title="新增导航节点（追加到顶层）"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={async () => {
          const v = await addForm.validateFields();
          const node: NavNode = { id: genId(), type: v.type, label: v.label };
          if (v.type === 'PAGE') node.refId = Number(v.refId);
          if (v.type === 'LINK') node.url = v.url;
          if (v.type === 'GROUP') node.children = [];
          setDraft([...draft, node]);
          setDirty(true);
          setAddOpen(false);
        }}
      >
        <Form form={addForm} layout="vertical" initialValues={{ type: 'PAGE' }}>
          <Form.Item name="type" label="节点类型" rules={[{ required: true }]}>
            <Select options={[
              { value: 'PAGE', label: '页面（引用本应用 ACTIVE 页面）' },
              { value: 'GROUP', label: '分组（子节点需后续填充）' },
              { value: 'LINK', label: '外链（http/https）' },
            ]} />
          </Form.Item>
          <Form.Item name="label" label="显示名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.type !== b.type}>
            {({ getFieldValue }) => {
              const t = getFieldValue('type');
              if (t === 'PAGE') {
                return (
                  <Form.Item name="refId" label="引用页面" rules={[{ required: true, message: '请选择页面' }]}>
                    <Select
                      placeholder="选择本应用页面"
                      options={pages.map((p) => ({ value: p.id, label: `${p.name} (#${p.id})` }))}
                    />
                  </Form.Item>
                );
              }
              if (t === 'LINK') {
                return (
                  <Form.Item name="url" label="链接地址"
                    rules={[{ required: true, message: '请输入链接' }, {
                      pattern: /^https?:\/\//i, message: '仅允许 http(s) 地址',
                    }]}>
                    <Input placeholder="https://..." />
                  </Form.Item>
                );
              }
              return null;
            }}
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
