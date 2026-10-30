/**
 * 物料注册表（02FE §3 双轨分派的分派真源）：
 * MaterialMeta.runtime 决定轨道——dynamic 直接组件引用，compiled 走产物加载。
 * 本包只定义协议与注册表；组件实现由 component-materials / 设计器注入（DIP）。
 */
import type { ComponentType } from 'react';

export interface MaterialMeta {
  componentName: string;
  /** 轨道分派：dynamic=注册表组件（默认）；compiled=后端 build-service 产物。 */
  runtime: 'dynamic' | 'compiled';
  /** 轨道 A：动态解析组件（受控 value/onChange 契约——03FE §6）。 */
  component?: ComponentType<Record<string, unknown>>;
  /** 轨道 B：产物 hash → URL 由宿主注入的加载器解析（renderer 不直接发请求）。 */
  contentHash?: string;
  /** 物料图标与分组（设计器面板消费；渲染核心不消费）。 */
  icon?: string;
  group?: string;
}

export class MaterialRegistry {
  private materials = new Map<string, MaterialMeta>();

  register(meta: MaterialMeta): void {
    this.materials.set(meta.componentName, meta);
  }

  get(componentName: string): MaterialMeta | undefined {
    return this.materials.get(componentName);
  }

  has(componentName: string): boolean {
    return this.materials.has(componentName);
  }

  list(): MaterialMeta[] {
    return [...this.materials.values()];
  }

  clear(): void {
    this.materials.clear();
  }
}

/** 全局默认注册表（宿主可创建独立实例做隔离测试）。 */
export const materialRegistry = new MaterialRegistry();
