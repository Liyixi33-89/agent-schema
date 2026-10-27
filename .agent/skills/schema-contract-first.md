---
name: schema-contract-first
description: 双端契约先行——任何触碰表达式/Schema/OpenAPI 的改动必须契约同步、双端 diff
triggers:
  - functions.json
  - redlines.json
  - 表达式白名单
  - Schema 协议
  - OpenAPI
  - zod
version: 1
updated: 2026-10-26
---

# 双端契约先行

## 何时使用

改动涉及以下任一项：`functions.json`（L1 表达式白名单）、`redlines.json`（L2 脚本红线）、Schema 类型体系、OpenAPI 生成的 `api-types.gen.ts`、`contract/` 导出物。

## 规则/经验

1. **契约文件是唯一真源**：白名单/红线不得在代码里硬编码副本；运行时从文件加载（前端 ExprEngine 消费 functions.json，后端 Aviator 注册表由同文件生成）。
2. **改契约的完整链条**：改文件 → 双端实现同步 → `verify -Level commit`（含契约 diff 检查）→ spec §3 接口契约节更新。缺任何一环都不算完成。
3. **类型禁止手写镜像**：前端 DTO 只能来自 OpenAPI 生成；后端校验规则来自前端导出的 json-schema。发现「手写对齐」代码即返工。
4. 表达式新增函数的评审口径：无 IO、无副作用、纯函数、可静态类型推断，四条全过才能进白名单。

## 反模式

- 只改前端白名单没同步后端 → 流程分支/数据权限在后端 Aviator 求值时直接报「函数不存在」。(设计评审预判，2026-10)
- 在 PR 描述里写「已同步双端」但没有 diff 证据 → 以 verify 输出为准，口头承诺无效。(体系原则)

## 验证方式

`pwsh scripts/verify.ps1 -Level quick` 中契约 diff 检查通过；`contract/` 与后端生成物 diff 为空。
