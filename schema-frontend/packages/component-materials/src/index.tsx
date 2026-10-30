/**
 * 基础物料 15 个（05FE §5 薄封装原则）：
 * 每个 = MaterialMeta + 受控组件（value/onChange 契约——03FE §6，禁止内部自持状态）。
 * 薄封装纪律：只做「协议 props → AntD props」翻译与默认值收敛，不含业务逻辑。
 *
 * 运行时依赖说明：antd/react 为 peerDependencies——本包仅声明，
 * 由宿主（designer/runtime）提供实现（与 renderer 的零运行时 react 纪律一致）。
 */
import React from 'react';
import dayjs from 'dayjs';
import {
  Input, InputNumber, Select, DatePicker, Switch, Upload, Button, Table, Form,
  Card, Tabs, Collapse, Tooltip, Typography, Steps,
} from 'antd';
import type { MaterialMeta } from '@schema/schema-renderer';

export interface WidgetProps {
  value?: unknown;
  onChange?: (value: unknown) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  options?: { value: string; label: string }[];
  [key: string]: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** 受控组件映射表：componentName → AntD 薄封装。 */
const widgets: Record<string, React.ComponentType<WidgetProps>> = {
  TextInput: (p) => (
    <Input value={str(p.value) ?? ''} onChange={(e) => p.onChange?.(e.target.value)}
      placeholder={p.placeholder} disabled={bool(p.disabled)} />
  ),
  NumberInput: (p) => (
    <InputNumber value={typeof p.value === 'number' ? p.value : undefined}
      onChange={(v) => p.onChange?.(v)} disabled={bool(p.disabled)} style={{ width: '100%' }} />
  ),
  SelectInput: (p) => (
    <Select value={str(p.value)} onChange={(v) => p.onChange?.(v)}
      options={p.options ?? []} placeholder={p.placeholder} disabled={bool(p.disabled)} allowClear />
  ),
  DateInput: (p) => (
    // 值契约（2026-10-30 三轮收口）：协议值为 ISO 日期字符串；AntD DatePicker 消费 dayjs。
    // 入：字符串 → dayjs；出：onChange 回传 ISO 字符串（保持协议字符串语义不变）。
    <DatePicker
      value={str(p.value) ? dayjs(str(p.value)) : null}
      onChange={(_d, ds) => p.onChange?.(ds[0] ?? null)}
      disabled={bool(p.disabled)} style={{ width: '100%' }} />
  ),
  BooleanSwitch: (p) => (
    <Switch checked={!!p.value} onChange={(v) => p.onChange?.(v)} disabled={bool(p.disabled)} />
  ),
  FileUpload: (p) => {
    // 受控文件列（2026-10-30 三轮收口）：协议值 {fileId,name,size}——展示回显；
    // 新上传经 customRequest 调宿主注入的 uploader 换取真实 fileId（不再本地 uid 冒充）。
    const meta = (p.value ?? null) as { fileId?: string; name?: string; size?: number } | null;
    const fileList = meta?.fileId ? [{ uid: meta.fileId, name: meta.name ?? '附件', status: 'done' as const }] : [];
    return (
      <Upload
        maxCount={1}
        fileList={fileList}
        customRequest={(opt) => {
          const uploader = p.uploader as
            | ((file: File, onProgress: (pct: number) => void) => Promise<{ fileId: string }>)
            | undefined;
          const file = opt.file as unknown as File;
          if (!uploader) {
            // 宿主未注入上传通道：本地校验态回显（fileId 留空——提交层拦截空 fileId）
            opt.onSuccess?.({ fileId: '' });
            return;
          }
          uploader(file, (pct) => opt.onProgress?.({ percent: pct }))
            .then((r) => opt.onSuccess?.(r))
            .catch((e: unknown) => opt.onError?.(e as Error));
        }}
        onChange={(info) => {
          const last = info.fileList.at(-1);
          if (!last) return p.onChange?.(null);
          if (last.status === 'done' && last.response) {
            const fid = (last.response as { fileId?: string }).fileId;
            if (fid) return p.onChange?.({ fileId: fid, name: last.name, size: last.size ?? 0 });
          }
          if (last.status === 'removed') return p.onChange?.(null);
        }}
      >
        <Button disabled={bool(p.disabled)}>上传附件</Button>
      </Upload>
    );
  },
  RichtextInput: (p) => (
    <Input.TextArea value={str(p.value) ?? ''} onChange={(e) => p.onChange?.(e.target.value)}
      rows={4} disabled={bool(p.disabled)} />
  ),
  FormItem: (p) => (
    <Form.Item label={p.label} required={!!p.required}>
      {p.children as React.ReactNode}
    </Form.Item>
  ),
  PrimaryButton: (p) => (
    <Button type="primary" onClick={p.onClick as never} disabled={bool(p.disabled)}>
      {p.children as React.ReactNode ?? p.label}
    </Button>
  ),
  DataTable: (p) => (
    <Table size="small" pagination={{ pageSize: 20 }}
      columns={(p.columns as never) ?? []} dataSource={(p.dataSource as never) ?? (p.value as never) ?? []} />
  ),
  SectionCard: (p) => (
    <Card title={p.label} bordered={!bool(p.flat)}>
      {p.children as React.ReactNode}
    </Card>
  ),
  StepsWizard: (p) => {
    // 分步表单（03FE §5，2026-10-30 三轮收口）：受控 current + 步进回调（宿主接管步校验）。
    const current = typeof p.current === 'number' ? p.current : 0;
    return (
      <div>
        <Steps current={current} items={(p.stepLabels as string[] | undefined)?.map((t) => ({ title: t })) ?? []} />
        <div style={{ marginTop: 16 }}>
          {p.children as React.ReactNode}
          <div style={{ marginTop: 16 }}>
            <Button disabled={current === 0} onClick={p.onPrev as never}>上一步</Button>
            <Button type="primary" style={{ marginLeft: 8 }} onClick={p.onNext as never}>下一步</Button>
          </div>
        </div>
      </div>
    );
  },
  GroupCollapse: (p) => (
    <Collapse items={[{ key: 'g', label: p.label ?? '分组', children: p.children as React.ReactNode }]} />
  ),
  LabelText: (p) => <Typography.Text>{(p.children as React.ReactNode) ?? p.label ?? ''}</Typography.Text>,
  HintTooltip: (p) => (
    <Tooltip title={(p.tooltip ?? p.label) as React.ReactNode}>
      {(p.children as React.ReactNode) ?? <Typography.Text type="secondary">{p.label}</Typography.Text>}
    </Tooltip>
  ),
};

/** MaterialMeta 注册表（15 个——05FE §5 清单；runtime 全 dynamic 轨道 A）。 */
const MATERIAL_DEFS = [
  { componentName: 'TextInput', group: '输入', icon: 'edit' },
  { componentName: 'NumberInput', group: '输入', icon: 'number' },
  { componentName: 'SelectInput', group: '输入', icon: 'unordered-list' },
  { componentName: 'DateInput', group: '输入', icon: 'calendar' },
  { componentName: 'BooleanSwitch', group: '输入', icon: 'switch' },
  { componentName: 'FileUpload', group: '输入', icon: 'paper-clip' },
  { componentName: 'RichtextInput', group: '输入', icon: 'align-left' },
  { componentName: 'FormItem', group: '布局', icon: 'appstore' },
  { componentName: 'PrimaryButton', group: '动作', icon: 'play-circle' },
  { componentName: 'DataTable', group: '数据', icon: 'table' },
  { componentName: 'SectionCard', group: '布局', icon: 'block' },
  { componentName: 'StepsWizard', group: '布局', icon: 'insert' },
  { componentName: 'GroupCollapse', group: '布局', icon: 'folder' },
  { componentName: 'LabelText', group: '展示', icon: 'font-size' },
  { componentName: 'HintTooltip', group: '展示', icon: 'info-circle' },
] as const;

export const BASIC_MATERIALS: MaterialMeta[] = MATERIAL_DEFS.map((m) => ({
  componentName: m.componentName,
  runtime: 'dynamic' as const,
  group: m.group,
  icon: m.icon,
  component: widgets[m.componentName],
}));

/** 字段类型 → 默认 widget 推断表（03FE §2——可被 LayoutNode.props 覆盖）。 */
export function defaultWidgetFor(fieldType: string): string {
  switch (fieldType) {
    case 'text': return 'TextInput';
    case 'number': return 'NumberInput';
    case 'enum': return 'SelectInput';
    case 'date': return 'DateInput';
    case 'boolean': return 'BooleanSwitch';
    case 'file': return 'FileUpload';
    case 'richtext': return 'RichtextInput';
    case 'relation': case 'user': return 'SelectInput';
    case 'dept': return 'SelectInput';
    case 'computed': return 'LabelText';
    default: return 'TextInput';
  }
}

/** 一次性注册全部基础物料（宿主启动时调用）。 */
export function registerBasicMaterials(target: import('@schema/schema-renderer').MaterialRegistry): void {
  for (const m of BASIC_MATERIALS) target.register(m);
}
