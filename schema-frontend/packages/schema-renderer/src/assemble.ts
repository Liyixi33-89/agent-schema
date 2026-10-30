/**
 * 组件装配层（React 绑定）：指令流 → React 元素。
 * 依赖说明：仅 import type（零运行时 react 依赖——本包 build 无需 react）；
 * 宿主（designer/runtime）传入 createElement 与组件查找函数完成装配。
 */
import type { ComponentType, ReactNode } from 'react';
import type { RenderInstruction } from './renderer';

export type ComponentResolver = (componentName: string) => ComponentType<Record<string, unknown>> | undefined;

export interface AssembleOptions {
  createElement: typeof import('react').createElement;
  resolveComponent: ComponentResolver;
  /** 节点包装器（设计态选中框/标黄——运行态不传）。 */
  wrapNode?: (instruction: RenderInstruction, children: ReactNode) => ReactNode;
}

/** 指令流 → React 元素树（双轨分派的宿主侧终点：resolveComponent 决定 dynamic/compiled）。 */
export function assembleTree(
  instructions: readonly RenderInstruction[],
  options: AssembleOptions,
): ReactNode[] {
  const { createElement, resolveComponent, wrapNode } = options;
  const build = (instruction: RenderInstruction): ReactNode => {
    const Comp = resolveComponent(instruction.componentName);
    if (!Comp) {
      // UnknownWidget 兜底（02FE §3）： componentName 原样透传给宿主默认占位组件
      const Fallback = resolveComponent('__UnknownWidget__');
      if (!Fallback) return null;
      return createElement(Fallback, { ...instruction.props, name: instruction.componentName, key: instruction.nodeId });
    }
    const children = instruction.children.map(build);
    const element = createElement(
      Comp,
      { ...instruction.props, 'data-node-id': instruction.nodeId, key: instruction.nodeId },
      children.length ? children : undefined,
    );
    if (wrapNode) return wrapNode(instruction, element);
    return element;
  };
  return instructions.map(build);
}
