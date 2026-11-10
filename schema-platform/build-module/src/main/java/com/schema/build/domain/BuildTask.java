package com.schema.build.domain;

import java.util.List;
import java.util.Map;

/**
 * 编译任务领域模型（04BE §2）：状态机 + 产物键 + 错误明细。
 * 铁律：失败不覆盖——线上继续跑上一版产物。
 */
public final class BuildTask {

    public enum Status { QUEUED, RUNNING, SUCCESS, FAILED, SECURITY_BLOCKED }

    /** 单条编译/红线错误（04BE §A.5 errors[]）。 */
    public record CompileError(Integer line, Integer column, String message, String code) {
        public Map<String, Object> toMap() {
            var m = new java.util.LinkedHashMap<String, Object>();
            if (line != null) m.put("line", line);
            if (column != null) m.put("column", column);
            m.put("message", message);
            if (code != null) m.put("code", code);
            return m;
        }
    }

    /** 成功结果额外携带产物源码（上传④用；对外协议不含产物体）。 */
    public record Result(boolean success, String contentHash, String artifact, List<CompileError> errors, int durationMs) {
        public Result(boolean success, String contentHash, List<CompileError> errors, int durationMs) {
            this(success, contentHash, null, errors, durationMs);
        }

        public static Result securityBlocked(List<CompileError> errors) {
            return new Result(false, null, null, errors, 0);
        }
    }

    private BuildTask() {
    }
}
