"""本地发布编排（Windows/PowerShell 与 CI Linux 通用，Python 3.9+）。

构建 -> 上传 -> 切换 -> 验证，一条链完成；HTTPS 未上线（仅 IP）是用户明确决策，
本脚本只负责应用版本化发布，不碰 nginx/TLS 配置。

用法（在仓库根目录执行）：
  python scripts/deploy.py --version <commit-ish> [--skip-build] [--skip-verify]

流程：
  1. 校验 git 工作区干净且 HEAD == 目标版本（发布必须可追溯到唯一 commit）；
  2. verify.ps1 -Level commit（除非 --skip-verify，CI 已跑过可跳）；
  3. 构建后端 jar + 三前端产物（pnpm build）；
  4. 打 tar 流经 SSH 上传服务器 releases/<version>/（版本不可覆盖）；
  5. 服务器执行 schema-release.sh switch（自动备份 DB -> 切链 -> 重启 -> 就绪探针 -> 失败回滚）；
  6. 发布后独立验证三个入口 + 版本接口（版本号与目标 commit 一致才算成功）。

环境要求：ssh/scp 可用且已配免密；服务器端已安装 scripts/schema-release.sh。
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = os.environ.get("SCHEMA_DEPLOY_HOST", "root@111.231.57.177")
# 部署通道：日常发布用 deploy 专用账号（setup-deploy-user.sh 创建，sudo 白名单仅 schema-release.sh）；
# root 直连仅作为初始化/救援通道保留（环境变量 SCHEMA_DEPLOY_ROLE 可临时覆盖）。
ROLE = os.environ.get("SCHEMA_DEPLOY_ROLE", "deploy")
REMOTE_ROOT = "/opt/schema"
ENTRIES = {  # 入口 -> 路径（发布后独立验证）
    "runtime": "/",
    "designer": "/designer/",
    "admin": "/admin/",
}

# ---------- 验收面（--target accept）----------
# 验收面与生产面物理隔离：独立后端实例（18081）+ 独立库（schema_acceptance）+
# 独立静态目录（/opt/schema/staging/accept/）。此前靠手工 scp 覆盖，无版本追溯、
# 无 MANIFEST 校验——本分支把它纳入同一条发布链（构建 → 校验 → 原子切换 → 验证）。
ACCEPT_ROOT = "/opt/schema/staging/accept"
ACCEPT_BACKEND_PORT = 18081
ACCEPT_ENTRIES = {  # 验收面入口（nginx accept-loopback.conf 的 alias 路径）
    "designer": "/accept/designer/",
    "runtime": "/accept/runtime/",
}
ACCEPT_PROBE = f"http://127.0.0.1:{ACCEPT_BACKEND_PORT}/internal/health/readiness"
# ⚠️ 服务器默认 java 是 JDK 17（class 61），而 jar 由 JDK 21 编译（class 65）——
#    必须用 JDK 21 全路径启动，否则 UnsupportedClassVersionError。
ACCEPT_JAVA = os.environ.get("SCHEMA_ACCEPT_JAVA", "/usr/lib/jvm/jre-21-konajdk/bin/java")


def run(cmd, cwd=None, check=True, capture=False):
    print(f"+ {' '.join(str(c) for c in cmd)}")
    return subprocess.run(
        [str(c) for c in cmd], cwd=cwd, check=check,
        shell=False if os.name != "nt" else True,  # Windows: mvn/pnpm 是 .cmd，必须走 shell
        capture_output=capture, text=True)


def ssh(remote_cmd, check=True, timeout=300):
    full = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", SERVER, remote_cmd]
    print(f"> ssh {remote_cmd}")
    r = subprocess.run(full, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        raise SystemExit(f"远程命令失败 (exit={r.returncode}): {remote_cmd}")
    return r


def require_clean_head(version: str) -> str:
    """发布版本必须是当前干净工作区的 HEAD——线上版本可精确追溯到 commit。"""
    status = run(["git", "status", "--porcelain"], cwd=ROOT, capture=True).stdout.strip()
    if status:
        raise SystemExit("工作区不干净——发布前必须提交或暂存本地改动:\n" + status)
    head = run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture=True).stdout.strip()
    short = run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture=True).stdout.strip()
    described = run(["git", "describe", "--always", "--dirty"], cwd=ROOT, capture=True).stdout.strip()
    if described.endswith("-dirty"):
        raise SystemExit("HEAD 处于 dirty 状态")
    if version not in (head, short, head[:8]):
        raise SystemExit(f"版本参数 {version} 与 HEAD {head[:12]} 不一致——只能发布当前检出的 commit")
    return head


def build(backend_jar: Path, web_dir: Path, accept: bool = False):
    print("== 构建后端 ==")
    run(["mvn", "-q", "-pl", "bootstrap", "-am", "package", "-DskipTests"], cwd=ROOT / "schema-platform")
    jar = ROOT / "schema-platform/bootstrap/target/bootstrap-0.1.0-SNAPSHOT.jar"
    if not jar.exists():
        raise SystemExit(f"构建产物缺失: {jar}")
    jar.replace(backend_jar)

    print("== 构建前端（designer/runtime/admin）==")
    fe = ROOT / "schema-frontend"
    run(["pnpm", "install", "--frozen-lockfile"], cwd=fe)
    if accept:
        # 验收面：ACCEPT_BASE=1 让 vite 输出 /accept/{designer,runtime}/ 的 base 与 dist-accept 目录
        env = dict(os.environ, ACCEPT_BASE="1", VITE_API_BASE="/accept")
        print("+ ACCEPT_BASE=1 VITE_API_BASE=/accept pnpm run build")
        r = subprocess.run(["pnpm", "run", "build"], cwd=fe, env=env,
                           shell=(os.name == "nt"), text=True)
        if r.returncode != 0:
            raise SystemExit(f"验收面前端构建失败 exit={r.returncode}")
    else:
        run(["pnpm", "run", "build"], cwd=fe)
    dist_root = fe / "apps"
    dist_name = "dist-accept" if accept else "dist"
    built = 0
    for app_dir in dist_root.iterdir():
        if (app_dir / dist_name).exists():
            built += 1
    if built < 3:
        raise SystemExit(f"前端产物不全（期望 3 个 {dist_name}，实际 {built}）")
    if accept:
        # 验收面：designer/runtime 各自独立目录（nginx alias 直指，不合并 assets）
        if web_dir.exists():
            raise SystemExit("web 目录已存在——构建流程不应复用")
        web_dir.mkdir(parents=True)
        import shutil
        for app, sub in (("runtime", "runtime"), ("designer", "designer"), ("admin-console", "admin")):
            src = dist_root / app / dist_name
            if not src.exists():
                raise SystemExit(f"缺少前端产物: {src}")
            shutil.copytree(src, web_dir / sub)
        print(f"== 验收面产物: {sorted(p.name for p in web_dir.iterdir())} ==")
        return
    # web/ 结构：runtime -> web/，designer -> web/designer/，admin -> web/admin/
    if web_dir.exists():
        raise SystemExit("web 目录已存在——构建流程不应复用")
    web_dir.mkdir(parents=True)
    import shutil
    # 资产统一合并（G-04 修复）：三应用 index 均引用 /assets/ 绝对路径（vite base='/assets/' 打平），
    # nginx 只服务一份 web/assets/——同路径同内容可复用（共享依赖同 hash），不同内容立即失败（构建漂移检测）。
    merged_assets = {}
    for app, sub in (("runtime", "."), ("designer", "designer"), ("admin-console", "admin")):
        src = dist_root / app / "dist"
        if not src.exists():
            raise SystemExit(f"缺少前端产物: {src}")
        dst = web_dir / sub
        dst.mkdir(parents=True, exist_ok=True)
        for item in src.iterdir():
            if item.is_file():
                shutil.copy2(item, dst / item.name)
            elif item.is_dir() and item.name == "assets":
                for asset in item.rglob("*"):
                    if not asset.is_file():
                        continue
                    rel = asset.relative_to(item).as_posix()
                    digest = hashlib.sha256(asset.read_bytes()).hexdigest()
                    if rel in merged_assets and merged_assets[rel] != digest:
                        raise SystemExit(
                            f"资产冲突: assets/{rel} 在多应用间内容不一致（{merged_assets[rel][:12]} != {digest[:12]}）"
                            "——检查 vite 构建配置是否漂移")
                    merged_assets[rel] = digest
            elif item.is_dir():
                shutil.copytree(item, dst / item.name, dirs_exist_ok=True)
    # 合并资产写入统一目录
    unified = web_dir / "assets"
    unified.mkdir(parents=True, exist_ok=True)
    for app, _ in (("runtime", ""), ("designer", ""), ("admin-console", "")):
        src_assets = dist_root / app / "dist" / "assets"
        if not src_assets.exists():
            continue
        for asset in src_assets.rglob("*"):
            if asset.is_file():
                rel = asset.relative_to(src_assets)
                target = unified / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists():
                    shutil.copy2(asset, target)
    print(f"== 资产合并: {len(merged_assets)} 个文件（统一 web/assets/）==")
    # 入口引用完整性：三个 index 引用的 JS/CSS 必须全部存在于统一资产目录
    import re as _re
    missing = []
    for sub in (".", "designer", "admin"):
        index = web_dir / sub / "index.html"
        if not index.exists():
            continue
        html = index.read_text(encoding="utf-8")
        for m in _re.finditer(r'(?:src|href)=["\'](/?assets/[^"\']+\.(?:js|css|woff2?))["\']', html):
            ref = m.group(1).lstrip("/")
            if not (web_dir / ref).exists():
                missing.append(f"{sub or 'root'}/index.html -> /{ref}")
    if missing:
        raise SystemExit("入口引用缺失（nginx 将 404 不回退 HTML）:\n  " + "\n  ".join(missing))


def make_version_file(version: str, workdir: Path, backend_jar: Path, web_dir: Path):
    """版本清单：commit、构建时间、jar 哈希——线上可回答『跑的是哪个提交』。"""
    digest = hashlib.sha256(backend_jar.read_bytes()).hexdigest()
    (workdir / "VERSION.txt").write_text(
        f"commit={version}\n"
        f"builtAt={time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
        f"jarSha256={digest}\n",
        encoding="utf-8")


def make_manifest(workdir: Path):
    """产物完整性清单（MANIFEST.sha256）：jar + web 全量文件哈希。

    服务器端 upload 逐条 sha256sum -c 比对——传输损坏/缺文件在上传阶段即拒绝入库，
    不再等到运行时发现。格式与 sha256sum -c 兼容（相对路径 + 两空格 + 哈希）。
    """
    lines = []
    for path in sorted(workdir.rglob("*")):
        if path.is_file() and path.name != "MANIFEST.sha256":
            rel = path.relative_to(workdir).as_posix()
            lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {rel}")
    manifest = "\n".join(lines) + "\n"
    (workdir / "MANIFEST.sha256").write_text(manifest, encoding="utf-8", newline="\n")
    print(f"== MANIFEST 生成: {len(lines)} 个文件 ==")


def deploy_accept(head: str, work: Path, backend_jar: Path, web_dir: Path):
    """验收面发布：静态产物 + 后端 jar 原子切换 + 版本注入 + 验证。

    与生产面的差异（有意为之）：
    - 后端是裸 java 进程（非 systemd），切换 = 停旧进程 → 起新进程；
    - 静态目录 /opt/schema/staging/accept/{designer,runtime,admin} 按版本目录软链；
    - 版本注入走 -D 系统属性（探针读 build-source.txt 或 APP_VERSION/GIT_COMMIT 环境）。
    """
    print("== 验收面：上传产物 ==")
    tar_path = work / "accept-bundle.tar.gz"
    with tarfile.open(tar_path, "w:gz") as tar:
        for name in ("schema-platform.jar", "web", "VERSION.txt", "MANIFEST.sha256"):
            tar.add(work / name, arcname=name)
    print(f"== 打包完成 {tar_path.stat().st_size // 1024} KiB ==")

    remote_stage = f"{ACCEPT_ROOT}/.incoming-{head[:12]}"
    ssh(f"rm -rf {remote_stage} && mkdir -p {remote_stage}")
    with open(tar_path, "rb") as f:
        proc = subprocess.Popen(
            ["ssh", "-o", "BatchMode=yes", SERVER, f"tar -xzf - -C {remote_stage}"],
            stdin=f, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out, _ = proc.communicate(timeout=600)
    if out.strip():
        print(out)
    if proc.returncode != 0:
        raise SystemExit(f"验收面上传失败 exit={proc.returncode}")

    print("== 验收面：MANIFEST 校验 ==")
    ssh(f"cd {remote_stage} && sha256sum -c MANIFEST.sha256 --quiet")

    print("== 验收面：原子切换 + 重启后端 ==")
    # 版本目录：/opt/schema/staging/accept/releases/<commit>，current 软链指向它
    ssh(
        f"set -e; "
        f"mkdir -p {ACCEPT_ROOT}/releases; "
        f"rm -rf {ACCEPT_ROOT}/releases/{head}; "
        f"mv {remote_stage} {ACCEPT_ROOT}/releases/{head}; "
        f"ln -sfn {ACCEPT_ROOT}/releases/{head} {ACCEPT_ROOT}/current; "
        # 静态目录按应用软链（nginx alias 直指这三个路径）
        f"for app in designer runtime admin; do "
        f"  rm -rf {ACCEPT_ROOT}/$app; "
        f"  ln -sfn {ACCEPT_ROOT}/current/web/$app {ACCEPT_ROOT}/$app; "
        f"done; "
        # 后端重启：停旧进程 → 起新进程（版本经环境变量注入，探针可追溯）
        # ⚠️ DeploymentProbeFilter 读 System.getenv(APP_VERSION/GIT_COMMIT) 或 Spring 属性
        #    app.version/git.commit——用环境变量前缀最直接（-D 是 JVM 属性，Spring 需 --app.version 形式）
        f"pkill -f 'schema-platform-accept.jar' || true; sleep 2; "
        f"cd {ACCEPT_ROOT}/current && "
        f"APP_VERSION={head} GIT_COMMIT={head} nohup {ACCEPT_JAVA} -jar schema-platform.jar "
        f"  --server.port={ACCEPT_BACKEND_PORT} "
        f"  --spring.datasource.url=jdbc:postgresql://127.0.0.1:5432/schema_acceptance "
        f"  --spring.datasource.username=schema_accept "
        f"  --spring.datasource.password=schema_accept_only_2026 "
        f"  > {ACCEPT_ROOT}/backend.log 2>&1 & "
        f"echo started"
    )

    print("== 验收面：验证（探针 + 入口）==")
    deadline = time.time() + 180
    probe = {}
    while time.time() < deadline:
        r = ssh(f"curl -sf -m 5 {ACCEPT_PROBE}", check=False)
        if r.returncode == 0 and r.stdout.strip():
            try:
                probe = json.loads(r.stdout)
                if probe.get("status") == "UP":
                    break
            except json.JSONDecodeError:
                pass
        time.sleep(5)
    print(f"  probe -> {probe}")
    if probe.get("status") != "UP":
        raise SystemExit("验收面后端未就绪（探针非 UP）")

    for name, path in ACCEPT_ENTRIES.items():
        r = ssh(f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1{path}", check=False)
        code = r.stdout.strip()
        print(f"  {name:10s} {path:22s} -> {code}")
        if code != "200":
            raise SystemExit(f"验收面入口验证失败: {name} -> {code}")

    print(f"\n验收面发布成功: {head[:12]}")
    print(f"  探针: {ACCEPT_PROBE}")
    print(f"  入口: http://{SERVER.split('@')[-1]}/accept/designer/ , /accept/runtime/")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True, help="git commit（完整或短 hash）")
    ap.add_argument("--target", choices=["prod", "accept"], default="prod",
                    help="发布目标：prod=生产面（默认）/ accept=验收面")
    ap.add_argument("--skip-build", action="store_true")
    ap.add_argument("--skip-verify", action="store_true")
    args = ap.parse_args()

    head = require_clean_head(args.version)

    if not args.skip_verify:
        print("== verify (commit 级) ==")
        run(["powershell" if os.name == "nt" else "pwsh",
             "-NoProfile", "-File", "scripts/verify.ps1", "-Level", "commit"], cwd=ROOT)

    with tempfile.TemporaryDirectory(prefix="schema-release-") as td:
        work = Path(td)
        backend_jar = work / "schema-platform.jar"
        web_dir = work / "web"
        if not args.skip_build:
            build(backend_jar, web_dir, accept=(args.target == "accept"))
        else:
            raise SystemExit("--skip-build 暂未支持（无产物缓存机制）")
        make_version_file(head, work, backend_jar, web_dir)
        make_manifest(work)

        if args.target == "accept":
            deploy_accept(head, work, backend_jar, web_dir)
            return

        tar_path = work / "bundle.tar.gz"
        with tarfile.open(tar_path, "w:gz") as tar:
            for name in ("schema-platform.jar", "web", "VERSION.txt", "MANIFEST.sha256"):
                tar.add(work / name, arcname=name)
        print(f"== 打包完成 {tar_path.stat().st_size // 1024} KiB ==")

        print("== 上传 ==")
        # 上传与切换统一走 sudo 白名单通道：deploy 用户可执行 schema-release.sh（root 权限内收口在该脚本）
        with open(tar_path, "rb") as f:
            proc = subprocess.Popen(
                ["ssh", "-o", "BatchMode=yes", SERVER,
                 f"sudo -n bash {REMOTE_ROOT}/schema-release.sh upload {head}"],
                stdin=f, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        out, _ = proc.communicate(timeout=600)
        print(out)
        if proc.returncode != 0:
            raise SystemExit(f"上传失败 exit={proc.returncode}")

    print("== 切换版本（服务器侧：发布锁 -> DB 备份 -> 探针+三入口+commit 全量验证 -> 失败自动回滚）==")
    ssh(f"sudo -n bash {REMOTE_ROOT}/schema-release.sh switch {head}")

    print("== 发布后独立复验（不依赖服务器脚本自身结论）==")
    for name, path in ENTRIES.items():
        r = ssh(f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1{path}", check=False)
        code = r.stdout.strip()
        print(f"  {name:8s} {path:12s} -> {code}")
        if code != "200":
            ssh(f"sudo -n bash {REMOTE_ROOT}/schema-release.sh rollback", check=False)
            raise SystemExit(f"入口验证失败且已触发服务器侧回滚: {name} -> {code}")
    probe = json.loads(ssh("curl -s http://127.0.0.1:18080/internal/health/readiness").stdout)
    print(f"  probe    -> {probe}")
    if probe.get("commit") not in (head, head[:8], head[:12]):
        ssh(f"sudo -n bash {REMOTE_ROOT}/schema-release.sh rollback", check=False)
        raise SystemExit(f"线上 commit 与目标不一致且已触发回滚: {probe.get('commit')} != {head[:12]}")

    print(f"\n发布成功: {head[:12]} @ {SERVER}")
    print(f"回滚命令: ssh {SERVER} 'bash {REMOTE_ROOT}/schema-release.sh rollback'")


if __name__ == "__main__":
    main()
