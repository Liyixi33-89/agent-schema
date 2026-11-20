/**
 * M13 页面设计器工作区（PRD 02 §2.2 三栏 + 04FE §4 拖拽管线）：
 * - 页面列表：新建（空白/由模型生成）/删除/路径设置
 * - 设计画布：物料面板（HTML5 DnD）→ schema-renderer DesignMode 渲染 → 属性面板（propsSchema 生成）
 * - 编辑内核：DesignerStore（page-designer 包）——一切修改经命令系统
 * - 保存链路：手动 + 30s 节流自动 + 409 冲突弹层（草稿保留/放弃/覆盖）
 *
 * 预览：发布后走 preview-grants → runtime 预览路由（真实凭证链——不做画布内假预览）。
 *
 * 渐进重构第二批：列表态拆至 PageListPanel、画布态拆至 PageCanvas、属性面板拆至
 * DesignerPanels、共享工具拆至 designerSupport——本文件收敛为编辑态切换编排壳。
 */
import React from 'react';
import { ApiClient, type AppCard } from '../../shared/api';
import PageListPanel from './PageListPanel';
import PageCanvas from './PageCanvas';

export default function PageDesignerTab({ api, app }: { api: ApiClient; app: AppCard }): React.ReactElement {
  const [editing, setEditing] = React.useState<{ pageId: string; draftVersion: number } | null>(null);
  // 列表重载触发器（画布退出时递增——PageListPanel 以 reloadKey 感知刷新）
  const [reloadKey, setReloadKey] = React.useState(0);

  if (editing) {
    return (
      <PageCanvas
        api={api}
        app={app}
        pageId={editing.pageId}
        initialDraftVersion={editing.draftVersion}
        onExit={() => { setEditing(null); setReloadKey((n) => n + 1); }}
      />
    );
  }

  return (
    <PageListPanel
      api={api}
      app={app}
      reloadKey={reloadKey}
      onDesign={(pageId, draftVersion) => setEditing({ pageId, draftVersion })}
    />
  );
}
