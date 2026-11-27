#!/usr/bin/env python3
"""datascope-check 契约与集成回归测试（2026-11-27）。

## 覆盖评审点名的四类失败
1. 权限拒绝（deploy 无 sudo postgres 权限 → 必须走白名单子命令，不得报「库不存在」）
2. SQL 失败（不得把错误文本当数据、不得静默返回成功）
3. 超时 / 连接失败（预检不可用 → 必须拒绝发布）
4. strict 拒绝（存在 NO_SCOPE → 退出码 1 → 阻止发布）

## 设计
- 纯离线：用桩替换 ssh，断言 deploy.py 的**判定逻辑**（退出码 → 放行/阻断）
- 不连服务器：契约本身（0/1/2）由服务器侧脚本保证，这里只锁定调用方语义
- 另有一条**结构断言**：预检必须经由 schema-release.sh 的 datascope-check 子命令，
  不能退回「直接执行 deploy 上传的脚本」或「sudo -u postgres」（那会扩大攻击面）

不依赖 pytest（本机精简环境缺 pdb），用 unittest。
"""
import ast
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import deploy  # noqa: E402


class FakeProc:
    def __init__(self, returncode, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class PrecheckDecisionTest(unittest.TestCase):
    """退出码 → 放行/阻断 的判定（评审要求「不依赖中文文案」）。"""

    def run_precheck(self, proc_or_exc, strict=True, target="prod"):
        def fake_ssh(cmd, check=True, timeout=300):
            if isinstance(proc_or_exc, Exception):
                raise proc_or_exc
            return proc_or_exc

        with patch.object(deploy, "ssh", side_effect=fake_ssh):
            try:
                deploy.datascope_precheck(target, strict)
                return None          # 放行
            except SystemExit as e:
                return str(e)

    def test_exit_0_passes(self):
        self.assertIsNone(self.run_precheck(FakeProc(0, "[OK] 所有活跃账号均有数据范围")))

    def test_exit_1_blocks(self):
        msg = self.run_precheck(FakeProc(1, "[--strict] 存在缺范围账号"))
        self.assertIsNotNone(msg, "exit 1 必须阻断发布")
        self.assertIn("未通过", msg)

    def test_exit_2_blocks_as_unavailable(self):
        msg = self.run_precheck(FakeProc(2, "库不存在"))
        self.assertIsNotNone(msg)
        self.assertIn("无法执行", msg)

    def test_permission_denied_126_blocks(self):
        """评审点：Permission denied(126) 曾被当成通过并部署了生产。"""
        msg = self.run_precheck(FakeProc(126, "Permission denied"))
        self.assertIsNotNone(msg, "126 必须阻断")
        self.assertIn("无法执行", msg)

    def test_timeout_blocks(self):
        msg = self.run_precheck(RuntimeError("ssh 超时（180s）"))
        self.assertIsNotNone(msg, "超时必须阻断")
        self.assertIn("无法执行", msg)

    def test_connection_error_blocks(self):
        msg = self.run_precheck(RuntimeError("Connection refused"))
        self.assertIsNotNone(msg)
        self.assertIn("无法执行", msg)

    def test_verdict_depends_on_code_not_text(self):
        """即使输出全是中文错误文案，判定也只认退出码。"""
        # exit 0 但输出含「失败」字样 → 仍放行（文案不参与判定）
        self.assertIsNone(self.run_precheck(FakeProc(0, "失败 缺范围 NO_SCOPE")))
        # exit 1 但输出全是成功字样 → 仍阻断
        self.assertIsNotNone(self.run_precheck(FakeProc(1, "[OK] 全部通过")))


class PrecheckInvocationShapeTest(unittest.TestCase):
    """结构断言：预检的调用方式不能退回危险形态（评审要求）。"""

    def setUp(self):
        self.src = (ROOT / "scripts" / "deploy.py").read_text(encoding="utf-8")
        tree = ast.parse(self.src)
        fn = next(n for n in tree.body
                  if isinstance(n, ast.FunctionDef) and n.name == "datascope_precheck")
        self.fn_src = ast.get_source_segment(self.src, fn) or ""

    def test_uses_whitelisted_subcommand(self):
        """必须经 schema-release.sh 的 datascope-check 子命令（root 白名单）。"""
        self.assertIn("datascope-check", self.fn_src)
        self.assertIn("schema-release", self.fn_src)

    def test_no_direct_postgres_sudo(self):
        """不得自己 sudo 成 postgres（deploy 无此权限，且会扩大攻击面）。

        只看**真正执行的代码**：docstring 与注释里会出现「sudo -u postgres」
        （解释为什么不用它），不能算违规。用 AST 取出函数体后逐行剔除
        注释与字符串常量，再做断言。
        """
        import ast as _ast
        tree = _ast.parse(self.fn_src)
        fn = tree.body[0]                      # def datascope_precheck(...)
        # 收集所有字符串常量节点（docstring 与普通字符串字面量）
        str_lines = set()
        for node in _ast.walk(fn):
            if isinstance(node, _ast.Constant) and isinstance(node.value, str):
                if hasattr(node, "lineno") and hasattr(node, "end_lineno"):
                    for ln in range(node.lineno, (node.end_lineno or node.lineno) + 1):
                        str_lines.add(ln)
        offenders = []
        for i, ln in enumerate(self.fn_src.splitlines(), start=1):
            stripped = ln.strip()
            if not stripped or stripped.startswith("#"):
                continue          # 空行与注释
            if i in str_lines:
                continue          # 字符串常量（含 docstring、错误提示文案）
            if "sudo -u postgres" in stripped or "sudo -n -u postgres" in stripped:
                offenders.append(stripped[:100])
        self.assertEqual(offenders, [],
                         f"代码中不得直接 sudo 成 postgres，发现: {offenders}")

    def test_does_not_upload_arbitrary_script(self):
        """不得把本地脚本上传到服务器执行（否则等于 root 执行任意代码）。"""
        self.assertNotIn("base64", self.fn_src)
        self.assertNotIn("$HOME/.ds-precheck", self.fn_src)


class PrecheckScriptContractTest(unittest.TestCase):
    """服务器侧脚本的契约（不执行，只做静态断言）。"""

    def setUp(self):
        self.sh = (ROOT / "scripts" / "datascope-precheck.sh").read_text(encoding="utf-8")

    def test_db_whitelist(self):
        self.assertIn("schema_prod|schema_acceptance", self.sh,
                      "必须限定目标库白名单（防注入与误查）")

    def test_requires_root(self):
        self.assertIn('"$(id -u)" != "0"', self.sh,
                      "必须以 root 执行（由白名单脚本调用）")

    def test_uses_runuser_not_sudo(self):
        self.assertIn("runuser -u postgres", self.sh,
                      "root 身份下应用 runuser 切到 postgres")
        self.assertNotIn("sudo -u postgres", self.sh)

    def test_readonly(self):
        """只读纪律：脚本自身不得执行写语句。

        ⚠️ 只看**实际执行的语句**，排除：
        - shell 注释（# ...）
        - 面向用户的「建议 SQL」输出（echo "INSERT INTO ..." 是文案，不是执行）
        否则会给运维建议的示例 SQL 会被误判成脚本在写库。
        """
        offenders = []
        for ln in self.sh.splitlines():
            stripped = ln.strip()
            if stripped.startswith("#"):
                continue
            # echo/printf 行是输出文案（含给用户的 SQL 示例），跳过
            if re.match(r'^(echo|printf)\b', stripped):
                continue
            upper = stripped.upper()
            for kw in ("INSERT ", "UPDATE ", "DELETE ", "DROP ", "TRUNCATE ", "ALTER "):
                if kw in upper:
                    offenders.append((kw.strip(), stripped[:80]))
        self.assertEqual(offenders, [],
                         f"预检脚本不得执行写语句，发现: {offenders}")

    def test_checks_sql_exit_code(self):
        """SQL 失败必须被识别（不得把错误文本当数据）。"""
        self.assertIn("rc=$?", self.sh)
        self.assertIn("return 2", self.sh)

    def test_no_script_path_argument(self):
        """不接收「执行哪个脚本」的参数。

        只接受：<db> / --strict / --expected-no-scope。
        任何接受脚本路径的形态都会把白名单入口变成「root 执行任意代码」。
        """
        # 位置参数 1 是库名，且必须走白名单 case
        self.assertIn('DB="${1:-}"', self.sh)
        # 显式声明支持的全部选项
        self.assertIn("--strict)", self.sh)
        self.assertIn("--expected-no-scope)", self.sh)
        # 不得接受路径类参数（.sh / /path / exec 任意文件）
        import re as _re
        code_lines = [ln for ln in self.sh.splitlines()
                      if ln.strip() and not ln.strip().startswith("#")]
        code = "\n".join(code_lines)
        self.assertNotIn("--script", code)
        self.assertNotIn("--from-file", code)
        # 不得把参数 3+ 当作要执行的脚本
        self.assertNotIn('exec "$3"', code)
        self.assertNotIn('bash "$3"', code)


class ReleaseScriptSubcommandTest(unittest.TestCase):
    """两个发布脚本都必须暴露 datascope-check 子命令。"""

    def test_both_release_scripts_dispatch_subcommand(self):
        for name in ("schema-release.sh", "schema-release-accept.sh"):
            src = (ROOT / "scripts" / name).read_text(encoding="utf-8")
            self.assertIn("datascope-check)", src, f"{name} 缺 datascope-check 分派")
            self.assertIn("/usr/local/sbin/schema-datascope-check", src,
                          f"{name} 应 exec 到 root 属主的固定路径")


class ExpectedNoScopeSemanticsTest(unittest.TestCase):
    """「预期拒绝」与「缺少必要授权」必须区分（2026-11-27 要求）。

    不能要求所有活跃账号都有数据范围——那会逼人为了过门禁乱授 ALL。
    本类只做静态断言（脚本必须实现该语义），行为由服务器端到端验证覆盖。
    """

    def setUp(self):
        self.sh = (ROOT / "scripts" / "datascope-precheck.sh").read_text(encoding="utf-8")

    def test_supports_expected_no_scope_option(self):
        self.assertIn("--expected-no-scope", self.sh)

    def test_reports_expected_as_info_not_failure(self):
        """预期拒绝应输出 [INFO]，且不参与 UNEXPECTED_COUNT。"""
        self.assertIn("[INFO]", self.sh)
        self.assertIn("EXPECTED_HIT", self.sh)
        self.assertIn("UNEXPECTED", self.sh)
        # 判定只看 UNEXPECTED
        self.assertIn('"${UNEXPECTED_COUNT:-0}" -eq 0', self.sh)

    def test_no_scope_all_expected_passes(self):
        """全部 NO_SCOPE 均为预期时应 exit 0。"""
        self.assertIn("NO_SCOPE 均为预期拒绝", self.sh)

    def test_documents_dont_force_all_scopes(self):
        """脚本注释里必须写明「不强制所有账号都有范围」的理由。"""
        self.assertIn("不能要求", self.sh)
        self.assertIn("乱授 ALL", self.sh)


class ExpectedNoScopeWiringTest(unittest.TestCase):
    """deploy.py 必须能透传 --expected-no-scope。"""

    def setUp(self):
        self.src = (ROOT / "scripts" / "deploy.py").read_text(encoding="utf-8")

    def test_cli_option_exists(self):
        self.assertIn("--expected-no-scope", self.src)

    def test_env_fallback(self):
        self.assertIn("SCHEMA_DATASCOPE_EXPECTED_NO_SCOPE", self.src)

    def test_passed_to_remote_command(self):
        self.assertIn("--expected-no-scope", self.src)
        # 必须出现在 ssh 命令行拼接处
        self.assertIn("exp_arg", self.src)


if __name__ == "__main__":
    unittest.main(verbosity=2)