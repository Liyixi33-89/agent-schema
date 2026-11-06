/**
 * 物料属性面板元数据（规格 §3.3）：PropSchemaGroup 定义于本包——
 * 渲染核心（schema-renderer）不消费设计态元数据，协议面保持纯净。
 */
import type { PropValue } from '@schema/schema-protocol';

export interface PropFieldSchema {
  key: string;
  label: string;
  /** 属性面板控件类型（antd 薄表单映射——非运行时物料协议）。 */
  widget: 'text' | 'textarea' | 'switch' | 'number' | 'select' | 'fieldRef' | 'expr';
  options?: { value: string; label: string }[];
  placeholder?: string;
}

export interface PropSchemaGroup {
  title: string;
  fields: PropFieldSchema[];
}

export interface PanelMaterial {
  componentName: string;
  group: string;
  icon: string;
  /** 是否容器（投放白名单——落点校验消费）。 */
  acceptChildren: boolean;
  defaultProps: Record<string, PropValue>;
  propsSchema: PropSchemaGroup[];
}
