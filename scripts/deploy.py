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
    "admin": "/accept/admin/",  # nginx schema.conf:49 已配置，部署必须一并验证
}
ACCEPT_PROBE = f"http://127.0.0.1:{ACCEPT_BACKEND_PORT}/internal/health/readiness"
PROD_PROBE = "http://127.0.0.1:18080/internal/health/readiness"
RELEASES_PATH = f"{ACCEPT_ROOT}/releases"
# ⚠️ 服务器默认 java 是 JDK 17（class 61），而 jar 由 JDK 21 编译（class 65）——
#    必须用 JDK 21 全路径启动，否则 UnsupportedClassVersionError。
ACCEPT_JAVA = os.environ.get("SCHEMA_ACCEPT_JAVA", "/usr/lib/jvm/jre-21-konajdk/bin/java")


def run(cmd, cwd=None, check=True, capture=False):
    print(f"+ {' '.join(str(c) for c in cmd)}")
    return subprocess.run(
        [str(c) for c in cmd], cwd=cwd, check=check,
        shell=False if os.name != "nt" else True,  # Windows: mvn/pnpm 是 .cmd，必须走 shell
        capture_output=capture, text=True)


def _key_args():
    """统一密钥/主机参数（CI 与本地路径不同，显式指定避免歧义）。"""
    args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
            "-o", "NumberOfPasswordPrompts=1"]
    key = os.environ.get("SCHEMA_DEPLOY_KEY_PATH")
    if key and Path(key).exists():
        args += ["-i", key]
    return args


def _ssh_base():
    """ssh 参数：额外禁 tty（远端非交互）。"""
    return ["ssh", "-T"] + _key_args()


def _scp_base():
    """scp 参数：不传 -T（scp 无该选项）。"""
    return ["scp"] + _key_args()


def ssh(remote_cmd, check=True, timeout=300):
    full = _ssh_base() + [SERVER, remote_cmd]
    print(f"> ssh {remote_cmd}")
    try:
        r = subprocess.run(full, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise SystemExit(
            f"ssh 超时（{timeout}s）: {remote_cmd}\n"
            "  排查：连接目标可达性 / 密钥路径(SCHEMA_DEPLOY_KEY_PATH) / known_hosts / sudo 白名单")
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
    # newline="\n" 强制 LF：Windows 默认 CRLF 会让服务器侧 grep 结果带 \r，
    # 导致「两个哈希看起来相同却不相等」的诡异失败（实测踩到）
    (workdir / "VERSION.txt").write_text(
        f"commit={version}\n"
        f"builtAt={time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n"
        f"jarSha256={digest}\n",
        encoding="utf-8", newline="\n")


def make_manifest(workdir: Path):
    """产物完整性清单（MANIFEST.sha256）：仅覆盖 **web 包内** 的文件。

    ## 为什么排除 jar（方案 1 分离传输后必需）
    分离传输时，纯前端改动会复用上一版本的 jar（SCHEMA_SKIP_BACKEND=1）。
    若 MANIFEST 仍含 jar 哈希，复用场景下必然对不上 → 误判「产物损坏」。
    jar 的完整性由 VERSION.txt 的 jarSha256 独立校验（服务器脚本 ④ 步），
    两道校验各管各的，互不干扰。

    格式与 sha256sum -c 兼容（相对路径 + 两空格 + 哈希）。
    """
    lines = []
    for path in sorted(workdir.rglob("*")):
        if not path.is_file():
            continue
        if path.name == "MANIFEST.sha256":
            continue
        rel = path.relative_to(workdir).as_posix()
        # 排除 jar：随 backend 包单独传输，由 VERSION.txt 校验
        if rel == "schema-platform.jar":
            continue
        lines.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {rel}")
    manifest = "\n".join(lines) + "\n"
    (workdir / "MANIFEST.sha256").write_text(manifest, encoding="utf-8", newline="\n")
    print(f"== MANIFEST 生成: {len(lines)} 个文件（不含 jar，jar 由 VERSION.txt 单独校验）==")


def _pack_tar(paths, out_path, *, compresslevel=None):
    """打包为 tar（可选 gzip 级别）。

    compresslevel=None 表示**不压缩**（tar 裸包）——用于 jar：
    它本身已是 zip，再 gzip 只省 11%，纯属浪费 CPU。
    """
    mode = "w:gz" if compresslevel is not None else "w"
    kwargs = {"compresslevel": compresslevel} if compresslevel is not None else {}
    with tarfile.open(out_path, mode, **kwargs) as tar:
        for src_path, arcname in paths:
            if src_path.exists():
                tar.add(src_path, arcname=arcname)


def deploy_accept(head: str, work: Path, backend_jar: Path, web_dir: Path):
    """验收面发布：分离传输（backend / web 独立）+ sudo 白名单通道。

    ⚠️ 为什么不能直接 ssh 执行 rm/mkdir：
    /opt/schema/staging/accept 属主是 root:root 755，deploy 用户只读。
    统一走 `sudo -n bash /opt/schema/schema-release-accept.sh`（白名单仅限该脚本）。

    ## 分离传输的由来（实测数据）
    | 产物 | 原始 | gzip |
    |---|---|---|
    | jar  | 34.5 MB | 30.9 MB（仅省 11%——jar 已是 zip）|
    | web  | 5.0 MB  | 1.86 MB（省 63%——JS/CSS 是文本）|

    全量 33MB 在 CI→服务器（境外链路 33KB/s）需 15 分钟以上，超时。
    分离后：
    - 纯前端改动 → 只传 web 1.86MB → 秒级
    - 后端改动   → 传 jar 30.9MB → 约 15 分钟（超时上限 1800s）

    ## 版本完整性
    即使分离传输，服务器端仍按 MANIFEST.sha256 逐文件校验；
    MANIFEST 与 VERSION.txt 随 web 包一起传（体积可忽略），
    确保任何单包损坏都能在上传阶段发现。
    """
    print("== 验收面：打包（分离传输）==")
    print(f"== 连接目标: {SERVER}（role={ROLE}）==")
    if "@" not in SERVER:
        raise SystemExit(f"SCHEMA_DEPLOY_HOST 缺少用户名前缀（应为 user@host）: {SERVER}")

    backend_tar = work / "accept-backend.tar"
    web_tar = work / "accept-web.tar.gz"

    t0 = time.time()
    _pack_tar([(backend_jar, "schema-platform.jar")], backend_tar)  # 不压缩
    print(f"   backend.tar  {backend_tar.stat().st_size / 1024 / 1024:.1f} MB  ({time.time()-t0:.1f}s)")

    t0 = time.time()
    web_items = [(work / "VERSION.txt", "VERSION.txt"),
                 (work / "MANIFEST.sha256", "MANIFEST.sha256")]
    for app in ("designer", "runtime", "admin"):
        web_items.append((web_dir / app, f"web/{app}"))
    _pack_tar(web_items, web_tar, compresslevel=6)
    print(f"   web.tar.gz   {web_tar.stat().st_size / 1024 / 1024:.2f} MB  ({time.time()-t0:.1f}s)")

    # 是否跳过 backend（纯前端改动）——由 --skip-backend 控制
    skip_backend = os.environ.get("SCHEMA_SKIP_BACKEND") == "1"

    remote_base = f"/tmp/schema-accept-{head[:12]}"

    if not skip_backend:
        remote_backend = remote_base + "-backend.tar"
        print(f"== scp 上传 backend -> {remote_backend} ==")
        t0 = time.time()
        r = subprocess.run(_scp_base() + [str(backend_tar), f"{SERVER}:{remote_backend}"],
                           capture_output=True, text=True, timeout=1800)
        if r.returncode != 0:
            print(r.stdout); print(r.stderr, file=sys.stderr)
            raise SystemExit(f"backend 上传失败 exit={r.returncode}")
        print(f"   完成 {backend_tar.stat().st_size/1024/1024:.1f} MB ({time.time()-t0:.1f}s)")
    else:
        remote_backend = ""
        print("== 跳过 backend 上传（SCHEMA_SKIP_BACKEND=1，复用服务器现有 jar）==")

    remote_web = remote_base + "-web.tar.gz"
    print(f"== scp 上传 web -> {remote_web} ==")
    t0 = time.time()
    r = subprocess.run(_scp_base() + [str(web_tar), f"{SERVER}:{remote_web}"],
                       capture_output=True, text=True, timeout=900)
    if r.returncode != 0:
        print(r.stdout); print(r.stderr, file=sys.stderr)
        raise SystemExit(f"web 上传失败 exit={r.returncode}")
    print(f"   完成 {web_tar.stat().st_size/1024/1024:.2f} MB ({time.time()-t0:.1f}s)")

    print("== 验收面：远端入库（校验 MANIFEST + 原子切换）==")
    backend_arg = remote_backend if remote_backend else "-"
    # ⚠️ 不能无条件 rm -rf releases/<head>：跳过 backend 时 head 与当前运行版本相同，
    #    删掉会让 current 软链指向不存在的目录（服务重启即挂）。
    #    改为：仅当该版本**不是**当前运行版本时才预清理（支持失败重试）。
    r = ssh(f"if [ \"$(readlink -f {RELEASES_PATH}/{head} 2>/dev/null)\" != "
            f"\"$(readlink -f {ACCEPT_ROOT}/current 2>/dev/null)\" ]; then "
            f"rm -rf {RELEASES_PATH}/{head}; fi; "
            f"sudo -n bash {REMOTE_ROOT}/schema-release-accept.sh ingest {head} "
            f"{remote_web} {backend_arg}; "
            f"rc=$?; rm -f {remote_web} {remote_backend}; exit $rc", timeout=900)
    print(r.stdout)

    print("== 验收面：切换版本（备份 → 切链 → 重启 → 验证 → 失败回滚）==")
    ssh(f"sudo -n bash {REMOTE_ROOT}/schema-release-accept.sh switch {head}", timeout=600)

    print("== 验收面：独立复验（不信任服务器脚本自身结论）==")
    for name, path in ACCEPT_ENTRIES.items():
        r = ssh(f"curl -s -o /dev/null -w '%{{http_code}}' http://127.0.0.1{path}", check=False)
        code = r.stdout.strip()
        print(f"  {name:10s} {path:22s} -> {code}")
        if code != "200":
            raise SystemExit(f"验收面入口验证失败: {name} -> {code}")

    probe = json.loads(ssh(f"curl -s {ACCEPT_PROBE}").stdout)
    print(f"  probe -> {probe}")
    if probe.get("status") != "UP":
        raise SystemExit("验收面后端未就绪（探针非 UP）")
    # commit 必须与目标完整 hash 完全一致。
    # 为什么不用 startswith / 短 hash 前缀匹配：那样 "abc123456789" 加任意后缀
    # 都能通过，版本校验形同虚设（deploy_test 的 aaaa...bbbb 用例守这条）。
    # 实际链路里 ingest 与 start_backend 都注入完整 hash（APP_VERSION=$version），
    # 探针必然返回完整值，因此完整匹配不会误伤。
    actual_commit = str(probe.get("commit", ""))
    if actual_commit != head:
        raise SystemExit(f"探针 commit={actual_commit} 与目标 {head} 不一致")

    print(f"\n验收面发布成功: {head[:12]}")
    print(f"  探针: {ACCEPT_PROBE}")
    print("  入口: /accept/designer/ , /accept/runtime/ , /accept/admin/")


def deploy_prod(head: str, work: Path, backend_jar: Path, web_dir: Path):
    """生产面发布：分离打包 -> scp 上传 -> 远端 ingest -> 切链 -> 独立复验。

    与验收面共用「分离传输」通道（stdin 管道传 30MB+ 在公网会挂住）。
    生产脚本 schema-release.sh 的 ingest 支持三态：
      ingest <ver> <web> <backend>   双包
      ingest <ver> <web> -           复用上一版本 jar
      ingest <ver> <web>             单包（jar 在 web 包内，兼容旧形式）
    """
    # 生产面同样走「分离打包 + scp 上传 + 远端 ingest」，
    # 与验收面共用一套可靠通道（stdin 管道在公网实测会挂住，已废弃）。
    backend_tar = work / "prod-backend.tar"
    web_tar = work / "prod-web.tar.gz"
    _pack_tar([(backend_jar, "schema-platform.jar")], backend_tar)
    # ⚠️ 生产 web/ 是**合并结构**（build(accept=False) 产出）：
    #    web/           ← runtime 的 index.html + assets/
    #    web/designer/  ← designer
    #    web/admin/     ← admin-console
    #    不能按验收面的 web/{designer,runtime,admin} 三个子目录去拷——
    #    那样会漏掉根目录 index.html 与统一 assets/，nginx 直接 404。
    web_items = [(work / "VERSION.txt", "VERSION.txt"),
                 (work / "MANIFEST.sha256", "MANIFEST.sha256"),
                 (web_dir, "web")]
    _pack_tar(web_items, web_tar, compresslevel=6)
    print(f"== 打包完成 backend {backend_tar.stat().st_size // 1024} KiB / "
          f"web {web_tar.stat().st_size // 1024} KiB ==")

    print("== 上传（scp -> 远端 ingest，超时 1800s 给慢链路留余量）==")
    remote_backend = f"/tmp/schema-prod-{head[:12]}-backend.tar"
    remote_web = f"/tmp/schema-prod-{head[:12]}-web.tar.gz"
    for local, remote in ((backend_tar, remote_backend), (web_tar, remote_web)):
        r = subprocess.run(_scp_base() + [str(local), f"{SERVER}:{remote}"],
                           capture_output=True, text=True, timeout=1800)
        if r.returncode != 0:
            print(r.stdout); print(r.stderr, file=sys.stderr)
            raise SystemExit(f"上传失败: {local.name} exit={r.returncode}")
        print(f"   {local.name} -> {remote} 完成")

    # 远端入库（生产脚本需支持双包形式；deploy 用户走 sudo 白名单）
    ingest = ssh(
        f"sudo -n bash {REMOTE_ROOT}/schema-release.sh ingest {head} {remote_web} {remote_backend}; "
        f"rc=$?; rm -f {remote_web} {remote_backend}; exit $rc", timeout=900)
    print(ingest.stdout)


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

    probe = json.loads(ssh(f"curl -s {PROD_PROBE}").stdout)
    print(f"  probe    -> {probe}")
    if probe.get("status") != "UP":
        ssh(f"sudo -n bash {REMOTE_ROOT}/schema-release.sh rollback", check=False)
        raise SystemExit("生产后端未就绪（探针非 UP）且已触发回滚")
    # 完整 hash 精确匹配（不用 startswith——见 deploy_accept 同处说明）
    actual_commit = str(probe.get("commit", ""))
    if actual_commit != head:
        ssh(f"sudo -n bash {REMOTE_ROOT}/schema-release.sh rollback", check=False)
        raise SystemExit(f"线上 commit={actual_commit} 与目标 {head} 不一致且已触发回滚")

    print(f"\n发布成功: {head[:12]} @ {SERVER}")
    print(f"回滚命令: ssh {SERVER} 'sudo -n bash {REMOTE_ROOT}/schema-release.sh rollback'")



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

        deploy_prod(head, work, backend_jar, web_dir)
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
