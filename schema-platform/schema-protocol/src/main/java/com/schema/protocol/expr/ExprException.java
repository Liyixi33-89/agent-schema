package com.schema.protocol.expr;

/**
 * 表达式引擎异常基类（M1.5 双端向量执行契约）。
 * 错误码字符串与前端 expression.ts 的错误名逐一对齐：
 *   FieldMissingError / EvalBudgetError / CompileError / EvalError
 * 向量文件断言的是这些 code 字符串（expr-test-vectors.json expect.error）。
 */
public class ExprException extends RuntimeException {

    private final String code;

    protected ExprException(String code, String message) {
        super(message);
        this.code = code;
    }

    /** 与前端错误名对齐的稳定标识，向量执行器据此断言。 */
    public String code() {
        return code;
    }

    public static ExprException fieldMissing(String field) {
        return new ExprException("FieldMissingError", "Referenced field not found: " + field);
    }

    public static ExprException budget(long limit) {
        return new ExprException("EvalBudgetError", "Expression exceeded " + limit + " evaluation steps");
    }

    public static ExprException compile(int line, int column, String message) {
        return new ExprException("CompileError", line + ":" + column + " " + message);
    }

    public static ExprException eval(String message) {
        return new ExprException("EvalError", message);
    }
}
