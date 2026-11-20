/**
 * 页面列表面板（M13 页面设计器列表态——自 PageDesignerTab.tsx 原样抽出，行为不变）：
 * - 页面列表：新建（空白/由模型生成）/删除/路径设置/预览
 * - 编辑态切换由父级持有（editing 状态上移——画布与列表互斥渲染）
 */
import React from 'react';
import {
  Button, Dropdown, Form, Input, List, message, Modal, Radio, Select, Space, Switch, Tag, Typography,
} from 'antd';
import type { MenuProps } from 'antd';
import { nanoid } from 'nanoid';
import {
  migrate, validatePageSchema, type PageSchema,
} from '@schema/schema-protocol';
import { defaultWidgetFor } from '@schema/component-materials';
import { generateDefaultLayout } from '@schema/page-designer';
import { ApiClient, type AppCard, type PageRow } from './api';
import { ensureMaterials, normalizeFields, showError } from './designerSupport';

export default function PageListPanel({ api, app, onDesign, reloadKey }: {
  api: ApiClient;
  app: AppCard;
  onDesign: (pageId: string, draftVersion: number) => void;
  reloadKey: number;
}): React.ReactElement {
  const [pages, setPages] = React.useState<PageRow[] | null>(null);

  const load = React.useCallback(async () => {
    try {
      const r = await api.listPages(app.id);
      setPages(r.list);
    } catch (e) {
      showError(e);
      setPages([]);
    }
  }, [api, app.id]);

  React.useEffect(() => { void load(); }, [load, reloadKey]);

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Text type="secondary">
          页面路径全局唯一；「由模型生成」按字段顺序生成默认表单布局（一次性快照——之后模型变更不自动改页面）。
        </Typography.Text>
        <Button type="primary" onClick={() => { ensureMaterials(); void openCreate(api, app.id, load); }}>新建页面</Button>
      </Space>
      <List
        loading={pages === null}
        dataSource={pages ?? []}
        locale={{ emptyText: '暂无页面——点击「新建页面」开始' }}
        renderItem={(p) => (
          <List.Item
            actions={[
              <Button key="design" type="link" onClick={async () => {
                ensureMaterials();
                try {
                  const d = await api.getPageDraft(p.id);
                  onDesign(String(p.id), d.draftVersion);
                } catch (e) { showError(e); }
              }}>设计</Button>,
              <Button key="preview" type="link" onClick={() => void openPreview(api, app.id, p.id)}>预览</Button>,
              <Dropdown key="more" menu={moreMenu(api, p, load)} trigger={['click']}>
                <Button type="link">···</Button>
              </Dropdown>,
            ]}
          >
            <List.Item.Meta
              title={<Space>{p.name}<Tag>{p.pageKey}</Tag>{p.status === 'PUBLISHED' ? <Tag color="green">已发布</Tag> : <Tag>草稿</Tag>}</Space>}
            />
          </List.Item>
        )}
      />
    </Space>
  );
}

function moreMenu(api: ApiClient, p: PageRow, reload: () => Promise<void>): MenuProps {
  return {
    items: [
      { key: 'path', label: '路径设置', onClick: () => void editPath(api, p, reload) },
      { key: 'delete', label: '删除页面', danger: true, onClick: () => void removePage(api, p, reload) },
    ],
  };
}

async function openCreate(api: ApiClient, appId: number, reload: () => Promise<void>): Promise<void> {
  // 新建向导：类型（表单/列表/详情/仪表盘，PRD 02 §2.1 三步 ①）+ 名称/标识/路径
  // + 选模型（可选——绑定后设计器可配字段绑定；勾选「生成默认布局」则创建后按模型字段
  // 生成表单骨架；DASHBOARD 不生成骨架——图表物料按需拖入，PRD 02 §2.6「仪表盘可不选模型」）
  const models = await api.listModels(appId).catch(() => ({ list: [], total: 0 }));
  let chosen: { type: 'FORM' | 'LIST' | 'DETAIL' | 'DASHBOARD'; modelId?: string; name: string; pageKey: string; path: string; generate?: boolean } | null = null;
  const modal = Modal.info({
    title: '新建页面',
    width: 520,
    okText: '创建',
    closable: true,
    content: (
      <CreatePageForm
        models={models.list.map((m) => ({ value: m.id, label: m.name }))}
        onSubmit={(v) => { chosen = v; }}
      />
    ),
    onOk: async () => {
      if (!chosen) return Promise.reject();
      try {
        const created = await api.createPage(appId, {
          pageKey: chosen.pageKey, name: chosen.name, type: chosen.type,
          modelId: chosen.modelId, path: chosen.path,
        });
        // 由模型生成默认布局：创建成功后立即保存生成骨架（失败不阻断创建流程，提示手动生成）
        if (chosen.type === 'FORM' && chosen.modelId && chosen.generate) {
          try {
            ensureMaterials();
            const draft = await api.getPageDraft(created.id);
            const schema = draft.schema as PageSchema;
            const detail = await api.modelDetail(appId, chosen.modelId);
            const page = validatePageSchema(migrate(schema));
            page.layout = generateDefaultLayout(normalizeFields(detail), {
              defaultWidgetFor, newId: () => nanoid(10),
            });
            await api.savePageDraft(created.id, page, draft.draftVersion);
          } catch (e) {
            message.warning('默认布局生成失败，可在设计器中手动搭建');
          }
        }
        message.success('页面已创建');
        modal.destroy();
        await reload();
      } catch (e) { showError(e); return Promise.reject(e); }
    },
  });
}

function CreatePageForm({ models, onSubmit }: {
  models: { value: string; label: string }[];
  onSubmit: (v: { type: 'FORM' | 'LIST' | 'DETAIL' | 'DASHBOARD'; modelId?: string; generate: boolean; name: string; pageKey: string; path: string }) => void;
}): React.ReactElement {
  const [form] = Form.useForm();
  const [hasModel, setHasModel] = React.useState(false);
  const [pageType, setPageType] = React.useState<'FORM' | 'LIST' | 'DETAIL' | 'DASHBOARD'>('FORM');
  const collect = (): void => {
    // 现取全量（Switch 后挂载时 onValuesChange 缓存的 generate 是 undefined——提交前必须重取）
    const v = form.getFieldsValue() as { name?: string; pageKey?: string; path?: string; modelId?: string; generate?: boolean };
    if (v.name && v.pageKey && v.path) {
      onSubmit({ type: pageType, modelId: v.modelId, generate: !!v.generate, name: v.name, pageKey: v.pageKey, path: v.path });
    }
  };
  React.useEffect(() => {
    // Switch 挂载后 initialValue 写入表单但不触发 onValuesChange——延迟补一次收集
    if (hasModel) { const t = window.setTimeout(collect, 50); return () => window.clearTimeout(t); }
  }, [hasModel]);
  return (
    <Form form={form} layout="vertical" onValuesChange={collect}>
      <Form.Item label="页面类型">
        <Radio.Group
          value={pageType}
          onChange={(e) => {
            const next = e.target.value as typeof pageType;
            setPageType(next);
            if (next === 'DASHBOARD') {
              // 仪表盘不生成表单骨架——清模型关联开关态并补一次收集
              form.setFieldValue('modelId', undefined);
              form.setFieldValue('generate', false);
              setHasModel(false);
            }
            const v = form.getFieldsValue() as { name?: string; pageKey?: string; path?: string };
            if (v.name && v.pageKey && v.path) {
              onSubmit({ type: next, modelId: undefined, generate: false, name: v.name, pageKey: v.pageKey, path: v.path });
            }
          }}
          options={[
            { value: 'FORM', label: '表单' },
            { value: 'LIST', label: '列表' },
            { value: 'DETAIL', label: '详情' },
            { value: 'DASHBOARD', label: '仪表盘' },
          ]}
        />
      </Form.Item>
      <Form.Item name="name" label="页面名称" rules={[{ required: true }]}><Input placeholder="如：报销登记表" /></Form.Item>
      <Form.Item name="pageKey" label="页面标识" rules={[{ required: true }]}><Input placeholder="如：expense_form" /></Form.Item>
      <Form.Item name="path" label="访问路径" rules={[{ required: true }]}><Input placeholder="如：/expense/form" /></Form.Item>
      {pageType !== 'DASHBOARD' ? (
        <Form.Item name="modelId" label="绑定模型（可选）">
          <Select allowClear options={models} placeholder="选择模型后可生成默认布局"
            onChange={(v) => { setHasModel(!!v); }} />
        </Form.Item>
      ) : (
        <Form.Item label="绑定模型（可选）">
          <Select allowClear options={models} disabled
            placeholder="仪表盘页图表数据源在属性面板按节点配置" />
        </Form.Item>
      )}
      {hasModel && pageType === 'FORM' ? (
        <Form.Item name="generate" label="由模型生成默认布局" valuePropName="checked" initialValue={true}>
          <Switch checkedChildren="生成" unCheckedChildren="空白" />
        </Form.Item>
      ) : null}
    </Form>
  );
}

async function editPath(api: ApiClient, p: PageRow, reload: () => Promise<void>): Promise<void> {
  let value = '';
  Modal.confirm({
    title: '路径设置',
    content: <Input defaultValue={`/p/${p.pageKey}`} onChange={(e) => { value = e.target.value; }} />,
    onOk: async () => {
      try {
        await api.updatePagePath(p.id, value || `/p/${p.pageKey}`);
        message.success('已更新');
        await reload();
      } catch (e) { showError(e); }
    },
  });
}

async function removePage(api: ApiClient, p: PageRow, reload: () => Promise<void>): Promise<void> {
  Modal.confirm({
    title: `删除页面「${p.name}」？`,
    content: '页面将从导航消失；逻辑删除不可自助恢复。',
    okButtonProps: { danger: true },
    onOk: async () => {
      try {
        await api.deletePage(p.id);
        message.success('已删除');
        await reload();
      } catch (e) { showError(e); }
    },
  });
}

export async function openPreview(api: ApiClient, appId: number, pageId: string | number): Promise<void> {
  try {
    const r = await api.issuePreviewGrant(appId, pageId);
    const url = `${window.location.origin}/runtime/#/preview?grant=${encodeURIComponent(r.grantId)}`;
    window.open(url, '_blank');
  } catch (e) { showError(e); }
}

