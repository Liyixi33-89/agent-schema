package com.schema.protocol.expr;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiFunction;

/**
 * L1 受限表达式求值器（后端宿主，10BE §5）。
 *
 * 与前端 ExprEngine（01FE §4）共享同一份语义向量真源 contract/expr-test-vectors.json，
 * JUnit 执行器跑全量断言结果与错误码一致——同名函数不等于同语义，向量锁死五类语义：
 * 日期时区（UTC）/ 空值传播 / 数值精度 half-up / 短路求值 / 强类型边界。
 *
 * 实现策略：与前端同构的递归下降求值（Tokenizer→Parser→AST→Evaluator），
 * 不引入 Aviator 作为求值内核——Aviator 语法面（赋值/三元/正则字面量）宽于 L1 白名单，
 * 受限模式需要逐项裁剪，其裁剪成本高于直接实现 400 行同构求值器；
 * Aviator 依赖保留给流程引擎条件分支场景（05BE §2.2，Flowable conditionExpression），
 * 届时函数注册表从同一 functions.json 生成（评审稿 §5 宿主矩阵）。
 *
 * 约束（与前端一致）：
 *  - 白名单函数 15 个（functions.json 唯一真源，JUnit 断言注册表与之一致）；
 *  - 步数上限 1000（每求值一个 AST 节点 +1，超限抛 EvalBudgetError）；
 *  - 标识符仅两类：白名单函数名 / scope 数据字段，缺失字段抛 FieldMissingError；
 *  - null 传染：null 参与算术/比较（==/!= 除外）结果为 null；CONCAT 跳过 null；
 *  - 不做隐式类型转换：'5' > 3 抛 EvalError（向量 TYPE-MISMATCH-COMPARE）。
 */
public final class ExprEngine {

    /** 求值步数上限（01FE §4 / 10BE §5 定版）。 */
    public static final long EVAL_BUDGET = 1000;

    /** 白名单函数注册表（与前端 contract/functions.json 同源，FunctionsContractTest 断言一致）。 */
    public static final Set<String> FUNCTION_NAMES = Set.of(
            "NOW", "DATE_DIFF", "DATE_FORMAT",
            "CONCAT", "UPPER", "LOWER", "REPLACE", "SPLIT", "TRIM",
            "ROUND", "ABS", "CEIL", "FLOOR",
            "INCLUDES", "LENGTH");

    private ExprEngine() {
    }

    // ===== AST =====

    public sealed interface Node permits Num, Str, Bool, NullLit, Ident, Call, Unary, Binary {
    }

    public record Num(double value) implements Node {
    }

    public record Str(String value) implements Node {
    }

    public record Bool(boolean value) implements Node {
    }

    public record NullLit() implements Node {
    }

    public record Ident(String name) implements Node {
    }

    public record Call(String name, List<Node> args) implements Node {
    }

    public record Unary(String op, Node operand) implements Node {
    }

    public record Binary(String op, Node left, Node right) implements Node {
    }

    /** 编译错误（行号+列号+原因，与前端 CompileError 对齐）。 */
    public record CompileError(int line, int column, String message) {
    }

    public static final class CompileException extends RuntimeException {
        public final CompileError error;

        public CompileException(CompileError error) {
            super(error.line() + ":" + error.column() + " " + error.message());
            this.error = error;
        }
    }

    // ===== Tokenizer + Parser =====

    private record Token(String kind, String text, int line, int column) {
    }

    public static Node compile(String source) {
        List<Token> tokens = tokenize(source);
        Parser parser = new Parser(tokens, source);
        Node ast = parser.parseExpression();
        if (parser.hasNext()) {
            Token t = parser.peek();
            throw new CompileException(new CompileError(t.line(), t.column(), "表达式后存在多余内容"));
        }
        return ast;
    }

    private static List<Token> tokenize(String src) {
        List<Token> tokens = new ArrayList<>();
        int pos = 0;
        int line = 1;
        int column = 1;
        while (pos < src.length()) {
            char ch = src.charAt(pos);
            if (ch == '\n') {
                pos++;
                line++;
                column = 1;
                continue;
            }
            if (Character.isWhitespace(ch)) {
                pos++;
                column++;
                continue;
            }
            if (ch == '/' && pos + 1 < src.length() && src.charAt(pos + 1) == '/') {
                while (pos < src.length() && src.charAt(pos) != '\n') {
                    pos++;
                }
                continue;
            }
            if (Character.isDigit(ch)) {
                int start = pos;
                while (pos < src.length() && (Character.isDigit(src.charAt(pos)) || src.charAt(pos) == '.')) {
                    pos++;
                }
                tokens.add(new Token("num", src.substring(start, pos), line, column));
                column += pos - start;
                continue;
            }
            if (ch == '"' || ch == '\'') {
                int start = pos;
                StringBuilder out = new StringBuilder();
                int i = pos + 1;
                while (i < src.length() && src.charAt(i) != ch) {
                    if (src.charAt(i) == '\\' && i + 1 < src.length()) {
                        out.append(src.charAt(i + 1));
                        i += 2;
                    } else {
                        out.append(src.charAt(i));
                        i++;
                    }
                }
                if (i >= src.length()) {
                    throw new CompileException(new CompileError(line, column, "未闭合的字符串"));
                }
                tokens.add(new Token("str", out.toString(), line, column));
                pos = i + 1;
                column = pos - start + 1;
                continue;
            }
            if (Character.isLetter(ch) || ch == '_' || ch >= 0x4e00) {
                int start = pos;
                while (pos < src.length() && (Character.isLetterOrDigit(src.charAt(pos)) || src.charAt(pos) == '_'
                        || src.charAt(pos) >= 0x4e00)) {
                    pos++;
                }
                tokens.add(new Token("ident", src.substring(start, pos), line, column));
                column += pos - start;
                continue;
            }
            String two = pos + 1 < src.length() ? src.substring(pos, pos + 2) : "";
            if (two.equals("==") || two.equals("!=") || two.equals(">=") || two.equals("<=")
                    || two.equals("&&") || two.equals("||")) {
                tokens.add(new Token("punct", two, line, column));
                pos += 2;
                column += 2;
                continue;
            }
            if ("+-*/%!<>().," .indexOf(ch) >= 0) {
                tokens.add(new Token("punct", String.valueOf(ch), line, column));
                pos++;
                column++;
                continue;
            }
            throw new CompileException(new CompileError(line, column, "非法字符 '" + ch + "'"));
        }
        return tokens;
    }

    private static final class Parser {
        private final List<Token> tokens;
        private final String source;
        private int idx;

        Parser(List<Token> tokens, String source) {
            this.tokens = tokens;
            this.source = source;
        }

        private static final Map<String, Integer> PRECEDENCE = createPrecedence();

        private static Map<String, Integer> createPrecedence() {
            Map<String, Integer> m = new HashMap<>();
            m.put("||", 1);
            m.put("&&", 2);
            m.put("==", 3);
            m.put("!=", 3);
            m.put(">", 4);
            m.put(">=", 4);
            m.put("<", 4);
            m.put("<=", 4);
            m.put("+", 5);
            m.put("-", 5);
            m.put("*", 6);
            m.put("/", 6);
            m.put("%", 6);
            return Map.copyOf(m);
        }

        boolean hasNext() {
            return idx < tokens.size();
        }

        Token peek() {
            return hasNext() ? tokens.get(idx) : null;
        }

        private Token next() {
            return tokens.get(idx++);
        }

        private boolean atPunct(String... values) {
            Token t = peek();
            return t != null && t.kind().equals("punct") && List.of(values).contains(t.text());
        }

        Node parseExpression() {
            return parseBinary(0);
        }

        private Node parseBinary(int minPrec) {
            Node left = parsePrimary();
            while (true) {
                Token t = peek();
                if (t == null || !t.kind().equals("punct")) {
                    break;
                }
                if (t.text().equals("=")) {
                    Token nxt = idx + 1 < tokens.size() ? tokens.get(idx + 1) : null;
                    if (nxt != null && nxt.kind().equals("punct") && nxt.text().equals(">")) {
                        throw new CompileException(new CompileError(t.line(), t.column(), "箭头函数不允许（L1 白名单语法）"));
                    }
                    throw new CompileException(new CompileError(t.line(), t.column(), "赋值不允许（L1 只读表达式）"));
                }
                if (t.text().equals("?") && source.contains("`")) {
                    throw new CompileException(new CompileError(t.line(), t.column(), "模板字符串不允许"));
                }
                if (t.text().equals("(")) {
                    throw new CompileException(new CompileError(t.line(), t.column(), "意外的函数调用（仅白名单全局函数可调用）"));
                }
                Integer prec = PRECEDENCE.get(t.text());
                if (prec == null || prec < minPrec) {
                    break;
                }
                next();
                Node right = parseBinary(prec + 1);
                left = new Binary(t.text(), left, right);
            }
            return left;
        }

        private Node parsePrimary() {
            Token t = peek();
            if (t == null) {
                throw new CompileException(new CompileError(1, Math.max(source.length() + 1, 1), "表达式意外结束"));
            }
            if (t.kind().equals("num")) {
                next();
                return new Num(Double.parseDouble(t.text()));
            }
            if (t.kind().equals("str")) {
                next();
                return new Str(t.text());
            }
            if (t.kind().equals("ident")) {
                next();
                if (t.text().equals("true")) {
                    return new Bool(true);
                }
                if (t.text().equals("false")) {
                    return new Bool(false);
                }
                if (t.text().equals("null")) {
                    return new NullLit();
                }
                if (atPunct("(")) {
                    if (!FUNCTION_NAMES.contains(t.text())) {
                        throw new CompileException(new CompileError(t.line(), t.column(), "非白名单函数: " + t.text()));
                    }
                    next();
                    List<Node> args = new ArrayList<>();
                    if (!atPunct(")")) {
                        while (true) {
                            args.add(parseExpression());
                            if (atPunct(",")) {
                                next();
                                continue;
                            }
                            break;
                        }
                    }
                    if (!atPunct(")")) {
                        throw new CompileException(new CompileError(t.line(), t.column(), "函数 " + t.text() + " 缺少 ')'"));
                    }
                    next();
                    return new Call(t.text(), args);
                }
                return new Ident(t.text());
            }
            if (t.kind().equals("punct")) {
                if (t.text().equals("(")) {
                    next();
                    Node inner = parseExpression();
                    if (!atPunct(")")) {
                        throw new CompileException(new CompileError(t.line(), t.column(), "缺少 ')'"));
                    }
                    next();
                    return inner;
                }
                if (t.text().equals("!")) {
                    next();
                    return new Unary("!", parseUnaryOperand());
                }
                if (t.text().equals("-")) {
                    next();
                    return new Unary("-", parseUnaryOperand());
                }
            }
            throw new CompileException(new CompileError(t.line(), t.column(), "意外的符号 '" + t.text() + "'"));
        }

        private Node parseUnaryOperand() {
            return parseBinary(7);
        }
    }

    // ===== Evaluator =====

    public record EvalResult(Object value, ExprException error) {
        public static EvalResult ok(Object value) {
            return new EvalResult(value, null);
        }

        public static EvalResult fail(ExprException error) {
            return new EvalResult(null, error);
        }
    }

    /** 求值入口：任一节点求值抛出的协议异常都收敛为 EvalResult.error（不向上抛）。 */
    public static EvalResult evaluate(Node ast, Map<String, Object> scope) {
        return evaluate(ast, scope, null);
    }

    /** clock 可注入固定时钟（向量 DATE_FORMAT-FIXED-CLOCK 用），null = 真实系统时钟（UTC）。 */
    public static EvalResult evaluate(Node ast, Map<String, Object> scope, Instant clock) {
        Ctx ctx = new Ctx(scope, clock);
        try {
            return EvalResult.ok(evalNode(ast, ctx));
        } catch (ExprException e) {
            return EvalResult.fail(e);
        }
    }

    private static final class Ctx {
        final Map<String, Object> scope;
        final Instant clock;
        long steps;

        Ctx(Map<String, Object> scope, Instant clock) {
            this.scope = scope;
            this.clock = clock;
        }

        void step() {
            if (++steps > EVAL_BUDGET) {
                throw ExprException.budget(EVAL_BUDGET);
            }
        }
    }

    private static Object evalNode(Node node, Ctx ctx) {
        ctx.step();
        if (node instanceof Num n) {
            return n.value();
        }
        if (node instanceof Str s) {
            return s.value();
        }
        if (node instanceof Bool b) {
            return b.value();
        }
        if (node instanceof NullLit) {
            return null;
        }
        if (node instanceof Ident id) {
            if (!ctx.scope.containsKey(id.name())) {
                throw ExprException.fieldMissing(id.name());
            }
            return ctx.scope.get(id.name());
        }
        if (node instanceof Unary u) {
            Object v = evalNode(u.operand(), ctx);
            if (v == null) {
                return null;
            }
            return u.op().equals("!") ? !truthy(v) : -asNumber(v, "一元 -");
        }
        if (node instanceof Call c) {
            return evalCall(c, ctx);
        }
        if (node instanceof Binary b) {
            return evalBinary(b, ctx);
        }
        throw ExprException.eval("未知 AST 节点: " + node.getClass().getSimpleName());
    }

    private static boolean truthy(Object v) {
        if (v instanceof List<?> list) {
            return !list.isEmpty();
        }
        if (v instanceof Boolean b) {
            return b;
        }
        if (v instanceof String s) {
            return !s.isEmpty();
        }
        if (v instanceof Number n) {
            return n.doubleValue() != 0.0;
        }
        return v != null;
    }

    private static Object evalBinary(Binary b, Ctx ctx) {
        String op = b.op();
        if (op.equals("&&")) {
            Object l = evalNode(b.left(), ctx);
            return truthy(l) ? evalNode(b.right(), ctx) : l;
        }
        if (op.equals("||")) {
            Object l = evalNode(b.left(), ctx);
            return truthy(l) ? l : evalNode(b.right(), ctx);
        }
        Object l = evalNode(b.left(), ctx);
        Object r = evalNode(b.right(), ctx);
        if (l == null || r == null) {
            if (op.equals("==")) {
                return l == r;
            }
            if (op.equals("!=")) {
                return l != r;
            }
            return null;
        }
        switch (op) {
            case "+":
                if (l instanceof String || r instanceof String) {
                    return stringify(l) + stringify(r);
                }
                return asNumber(l, "+") + asNumber(r, "+");
            case "-":
                return asNumber(l, "-") - asNumber(r, "-");
            case "*":
                return asNumber(l, "*") * asNumber(r, "*");
            case "/":
                return asNumber(l, "/") / asNumber(r, "/");
            case "%":
                return asNumber(l, "%") % asNumber(r, "%");
            case "==":
                return deepEquals(l, r);
            case "!=":
                return !deepEquals(l, r);
            case ">":
            case ">=":
            case "<":
            case "<=":
                return compare(op, l, r);
            default:
                throw ExprException.eval("未知运算符 " + op);
        }
    }

    private static boolean deepEquals(Object l, Object r) {
        if (l instanceof Number ln && r instanceof Number rn) {
            return ln.doubleValue() == rn.doubleValue();
        }
        return l.equals(r);
    }

    @SuppressWarnings("unchecked")
    private static Object compare(String op, Object l, Object r) {
        boolean sameKind = (l instanceof String && r instanceof String)
                || (l instanceof Number && r instanceof Number);
        if (!sameKind) {
            throw ExprException.eval("类型不匹配: " + typeName(l) + " " + op + " " + typeName(r));
        }
        int cmp;
        if (l instanceof String ls) {
            cmp = ls.compareTo((String) r);
        } else {
            double lv = ((Number) l).doubleValue();
            double rv = ((Number) r).doubleValue();
            cmp = Double.compare(lv, rv);
        }
        return switch (op) {
            case ">" -> cmp > 0;
            case ">=" -> cmp >= 0;
            case "<" -> cmp < 0;
            case "<=" -> cmp <= 0;
            default -> throw ExprException.eval("未知比较符 " + op);
        };
    }

    private static String stringify(Object v) {
        if (v instanceof Double d && d == Math.floor(d) && !d.isInfinite() && Math.abs(d) < 1e15) {
            // 数值拼接按 JS Number 语义：整数值不带小数点（与前端 `${l}${r}` 对齐）
            long l = d.longValue();
            return String.valueOf(l);
        }
        return String.valueOf(v);
    }

    private static double asNumber(Object v, String op) {
        if (v instanceof Number n) {
            return n.doubleValue();
        }
        throw ExprException.eval("操作数非数值: " + typeName(v) + " 于 " + op);
    }

    private static String typeName(Object v) {
        if (v == null) {
            return "null";
        }
        if (v instanceof String) {
            return "string";
        }
        if (v instanceof Number) {
            return "number";
        }
        if (v instanceof Boolean) {
            return "boolean";
        }
        return v.getClass().getSimpleName();
    }

    // ===== 白名单函数实现（语义与前端 expression.ts 逐向量对齐） =====

    @SuppressWarnings("unchecked")
    private static Object evalCall(Call call, Ctx ctx) {
        List<Object> args = new ArrayList<>(call.args().size());
        for (Node arg : call.args()) {
            args.add(evalNode(arg, ctx));
        }
        switch (call.name()) {
            case "NOW":
                return ctx.clock != null ? ctx.clock : Instant.now();
            case "DATE_DIFF": {
                Instant a = toDate(args.get(0));
                Instant b = toDate(args.get(1));
                Object unit = args.size() > 2 ? args.get(2) : null;
                if (a == null || b == null) {
                    return null;
                }
                long ms = a.toEpochMilli() - b.toEpochMilli();
                if ("DAY".equals(unit)) {
                    return ms / 86_400_000.0;
                }
                if ("WEEK".equals(unit)) {
                    return ms / (86_400_000.0 * 7);
                }
                if ("MONTH".equals(unit)) {
                    LocalDate da = LocalDate.ofInstant(a, ZoneOffset.UTC);
                    LocalDate db = LocalDate.ofInstant(b, ZoneOffset.UTC);
                    long months = ChronoUnit.MONTHS.between(db.withDayOfMonth(1), da.withDayOfMonth(1));
                    return da.getDayOfMonth() < db.getDayOfMonth() ? months - 1 : months;
                }
                throw ExprException.eval("DATE_DIFF 不支持单位 " + unit);
            }
            case "DATE_FORMAT": {
                Instant d = toDate(args.isEmpty() ? null : args.get(0));
                if (d == null) {
                    return null;
                }
                String fmt = args.size() > 1 && args.get(1) != null ? String.valueOf(args.get(1)) : "YYYY-MM-DD";
                return formatUtc(d, fmt);
            }
            case "CONCAT": {
                StringBuilder sb = new StringBuilder();
                for (Object a : args) {
                    if (a != null) {
                        sb.append(stringify(a));
                    }
                }
                return sb.toString();
            }
            case "UPPER":
                return args.isEmpty() || args.get(0) == null ? null : String.valueOf(args.get(0)).toUpperCase();
            case "LOWER":
                return args.isEmpty() || args.get(0) == null ? null : String.valueOf(args.get(0)).toLowerCase();
            case "REPLACE": {
                if (args.isEmpty() || args.get(0) == null) {
                    return null;
                }
                String s = String.valueOf(args.get(0));
                String search = args.size() > 1 ? String.valueOf(args.get(1)) : "";
                String replacement = args.size() > 2 ? String.valueOf(args.get(2)) : "";
                return s.replace(search, replacement);
            }
            case "SPLIT": {
                if (args.isEmpty() || args.get(0) == null) {
                    return null;
                }
                String s = String.valueOf(args.get(0));
                String sep = args.size() > 1 ? String.valueOf(args.get(1)) : " ";
                return List.of(s.split(sep, -1));
            }
            case "TRIM":
                return args.isEmpty() || args.get(0) == null ? null : String.valueOf(args.get(0)).trim();
            case "ROUND": {
                if (args.isEmpty() || args.get(0) == null) {
                    return null;
                }
                int digits = args.size() > 1 && args.get(1) != null
                        ? (int) asNumber(args.get(1), "ROUND") : 0;
                double n = asNumber(args.get(0), "ROUND");
                return roundHalfUp(n, digits);
            }
            case "ABS":
                return args.isEmpty() || args.get(0) == null ? null : Math.abs(asNumber(args.get(0), "ABS"));
            case "CEIL":
                return args.isEmpty() || args.get(0) == null ? null : Math.ceil(asNumber(args.get(0), "CEIL"));
            case "FLOOR":
                return args.isEmpty() || args.get(0) == null ? null : Math.floor(asNumber(args.get(0), "FLOOR"));
            case "INCLUDES": {
                Object list = args.isEmpty() ? null : args.get(0);
                if (list == null) {
                    return false;
                }
                if (list instanceof List<?> l) {
                    Object value = args.size() > 1 ? args.get(1) : null;
                    for (Object e : l) {
                        if (deepEquals(e, value)) {
                            return true;
                        }
                    }
                    return false;
                }
                throw ExprException.eval("INCLUDES 仅支持集合参数: " + typeName(list));
            }
            case "LENGTH": {
                Object target = args.isEmpty() ? null : args.get(0);
                if (target == null) {
                    return 0.0;
                }
                if (target instanceof String s) {
                    return (double) s.length();
                }
                if (target instanceof List<?> l) {
                    return (double) l.size();
                }
                return 0.0;
            }
            default:
                throw ExprException.eval("非白名单函数: " + call.name());
        }
    }

    private static Instant toDate(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof Instant i) {
            return i;
        }
        String s = String.valueOf(v);
        try {
            if (s.length() == 10) {
                return LocalDate.parse(s).atStartOfDay(ZoneOffset.UTC).toInstant();
            }
            if (s.endsWith("Z")) {
                return Instant.parse(s);
            }
            if (s.contains("+")) {
                return OffsetDateTime.parse(s).toInstant();
            }
            return LocalDateTime.parse(s).toInstant(ZoneOffset.UTC);
        } catch (Exception e) {
            return null;
        }
    }

    /** YYYY/MM/DD/HH/mm/ss 模式替换（与前端 formatDate 同款替换语义，UTC 定版）。 */
    private static String formatUtc(Instant d, String fmt) {
        LocalDate date = LocalDate.ofInstant(d, ZoneOffset.UTC);
        String out = fmt
                .replace("YYYY", String.format("%04d", date.getYear()))
                .replace("MM", String.format("%02d", date.getMonthValue()))
                .replace("DD", String.format("%02d", date.getDayOfMonth()));
        if (out.contains("HH") || out.contains("mm") || out.contains("ss")) {
            java.time.LocalDateTime ldt = LocalDateTime.ofInstant(d, ZoneOffset.UTC);
            out = out.replace("HH", String.format("%02d", ldt.getHour()))
                    .replace("mm", String.format("%02d", ldt.getMinute()))
                    .replace("ss", String.format("%02d", ldt.getSecond()));
        }
        return out;
    }

    /** 四舍五入 half-up（向量 ROUND-HALF-UP/-NEGATIVE 定版；与前端 roundHalfUp 同式）。 */
    private static double roundHalfUp(double n, int digits) {
        double factor = Math.pow(10, digits);
        return Math.signum(n) * Math.round(Math.abs(n) * factor + 1e-9) / factor;
    }
}
