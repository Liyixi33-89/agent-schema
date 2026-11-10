package com.schema.build.domain;

/**
 * 编译服务领域接口（04BE §2.2 CodeBuildService 收敛版——P1 最小链路）。
 * 实现必须保证：编译过程绝不执行客户代码（只做语法转换与打包）。
 */
public interface CodeBuildService {

    /**
     * 编译 L2 脚本源码。
     * @return 成功含 contentHash（产物已上传、任务已落库）；失败含 errors（contentHash 不回写）
     */
    BuildTask.Result build(BuildCommand command);

    record BuildCommand(long tenantId, Long appId, Long pageId, String sourceCode, String runtimeVersion) {
        public BuildCommand {
            if (sourceCode == null || sourceCode.isBlank()) {
                throw new IllegalArgumentException("sourceCode 不能为空");
            }
        }
    }
}
