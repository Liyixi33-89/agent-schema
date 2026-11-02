package com.schema.app.application;

import java.util.List;
import java.util.Map;

/**
 * 页面域切口（app-module 定义、page-module 实现——模块解耦口径）。
 *
 * <p>职责：导航树校验所需的页面归属判定、运行时导航权限过滤、删除影响面清单。
 * app-module 不直接依赖 page-module 的实现细节（接口在本模块，实现经 Spring 装配）。
 */
public interface AppPageRef {

    /** PAGE 节点 refId 是否为本应用 ACTIVE 页面（13BE §3.3 保存强校验）。 */
    boolean isPageOfApp(long tenantId, long appId, long pageId);

    /** 导航树按当前用户权限过滤（13BE §3.3：服务端过滤为准）。无权限节点整枝剪除。 */
    List<Object> filterNavTree(List<Object> tree, long tenantId, long appId, Long userId);

    /** 应用删除影响面清单（13BE §3.1 P1：模型/页面/流程计数）。 */
    Map<String, Object> impactOf(long appId, long tenantId);
}