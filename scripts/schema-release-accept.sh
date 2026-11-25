#!/usr/bin/env bash
# Schema 验收面发布脚本（服务器侧，sudo 白名单通道）
#
# 用法：
#   schema-release-accept.sh upload  <version>   # stdin 收 tar 流 -> MANIFEST 校验 -> 原子入库
#   schema-release-accept.sh switch  <version>   # 备份 -> 切链 -> 重启 -> 探针+入口验证 -> 失败回滚
#   schema-release-accept.sh status              # 当前版本/探针/目录状态
#
# 与生产脚本 schema-release.sh 的差异（有意为之）：
#   · 目标根目录 /opt/schema/staging/accept（生产是 /opt/schema）
#   · 后端是裸 java 进程（非 systemd），切换 = 按端口停旧 → 起新
#   · 探针端口 18081，入口是 /accept/{designer,runtime,admin}/
#   · 版本注入走环境变量 APP_VERSION/GIT_COMMIT（DeploymentProbeFilter 读这两个）
#
# 六道闸（沿用生产脚本的收口经验）：
#   1) 发布锁：与生产脚本共用 /run/lock——两个面不并发发布
#   2) 完整性：tar 内必须含 MANIFEST.sha256，逐条 sha256sum -c 比对
#   3) 原子性：先 staging，校验通过后 mv 入库；current 用 ln -sfn 原子替换
#   4) 成功条件 = 探针 UP + **探针 commit == 目标版本** + 三入口 200
#   5) 失败自动回滚到 previous（并验证回滚后可用）
#   6) 版本目录不可覆盖（同 commit 二次发布须先人工确认）
set -euo pipefail

ROOT=/opt/schema/staging/accept
RELEASES=$ROOT/releases
STAGING=$ROOT/staging
CURRENT=$ROOT/current
STATE=$ROOT/release-state.json
MANIFEST=MANIFEST.sha256
LOCK=/run/lock/schema-release.lock      # 与生产共用，避免两面同时发布
BACKUPS=$ROOT/backups
PORT=18081
BASE=http://127.0.0.1
HEALTH=$BASE:$PORT/internal/health/readiness
JAVA=/usr/lib/jvm/jre-21-konajdk/bin/java
DB_URL=jdbc:postgresql://127.0.0.1:5432/schema_acceptance
DB_USER=schema_accept
DB_PASS=schema_accept_only_2026
WAIT_TIMEOUT=150

log() { echo "[$(date '+%F %T')] $*"; }
die() { log "ERROR: $*"; exit 1; }
require_root() { [ "$(id -u)" = 0 ] || die "must run as root（经 sudo 白名单调用）"; }

acquire_lock() {
    exec 9>"$LOCK"
    flock -n 9 || die "已有发布任务运行中（$LOCK）"
}

read_state() { [ -f "$STATE" ] && python3 -c "import json;print(json.load(open('$STATE')).get('$1',''))" || true; }

write_state() {
    local tmp; tmp=$(mktemp "$STATE.tmp.XXXXXX")
    printf '{"current":"%s","previous":"%s","switchedAt":"%s"}\n' \
        "$1" "$2" "$(date -Is)" > "$tmp"
    chmod 644 "$tmp"; mv -f "$tmp" "$STATE"
}

probe_json() { curl -sf -m 5 "$HEALTH" 2>/dev/null || echo '{"status":"UNREACHABLE"}'; }

wait_ready() {
    local deadline=$((SECONDS + WAIT_TIMEOUT))
    while [ $SECONDS -lt $deadline ]; do
        curl -sf -m 5 "$HEALTH" >/dev/null 2>&1 && return 0
        sleep 3
    done
    return 1
}

# 全量验证：探针 UP + commit 匹配 + 三入口 200（任一失败即回滚）
verify_release() {
    local version="$1"
    if ! wait_ready; then
        log "验证失败：就绪探针不 UP（$(probe_json)）"
        return 1
    fi
    local entry
    for entry in /accept/designer/ /accept/runtime/ /accept/admin/; do
        local code; code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$BASE$entry" || echo 000)
        if [ "$code" != "200" ]; then
            log "验证失败：入口 $entry -> $code"
            return 1
        fi
    done
    local commit; commit=$(probe_json | python3 -c "import json,sys;print(json.load(sys.stdin).get('commit',''))" 2>/dev/null || true)
    if [ -z "$commit" ] || [ "$commit" = "unknown" ]; then
        log "验证失败：探针 commit 未注入（=unknown）——检查 APP_VERSION/GIT_COMMIT 是否传入"
        return 1
    fi
    # 允许目标传完整 sha 或短 sha：用前缀匹配（commit 必须以 version 开头）
    case "$commit" in
        "$version"*) ;;
        *) log "验证失败：线上 commit=$commit 与目标 $version 不一致"; return 1 ;;
    esac
    log "全量验证通过: 探针 UP + commit=$commit + 三入口 200"
    return 0
}

backup_db() {
    mkdir -p "$BACKUPS"; chmod 700 "$BACKUPS"
    local out="$BACKUPS/pre-accept-$(date '+%Y%m%d-%H%M%S').sql.gz"
    log "发布前备份验收库 -> $out"
    if ! PGPASSWORD="$DB_PASS" pg_dump -w -h 127.0.0.1 -U "$DB_USER" "$(db_name)" | gzip > "$out"; then
        rm -f "$out"; die "数据库备份失败——发布中止"
    fi
    chmod 600 "$out"
    ls -1t "$BACKUPS"/pre-accept-*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f --
}

db_name() { echo "$DB_URL" | sed 's|.*/||'; }

db_current() {
    PGPASSWORD="$DB_PASS" psql -w -h 127.0.0.1 -U "$DB_USER" -d "$(db_name)" -tAc \
        "SELECT max(split_part(version,'.',1)::int) FROM flyway_schema_history WHERE success" 2>/dev/null || echo 0
}

# 按端口停后端（不能按 jar 名：实际命令是 java -jar schema-platform.jar --server.port=18081）
stop_backend() {
    local pids
    pids=$(ss -lntp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u || true)
    if [ -n "$pids" ]; then
        log "停止端口 $PORT 上的进程: $pids"
        for p in $pids; do kill "$p" 2>/dev/null || true; done
        for _ in $(seq 1 25); do
            ss -lntp 2>/dev/null | grep -q ":$PORT " || break
            sleep 1
        done
        if ss -lntp 2>/dev/null | grep -q ":$PORT "; then
            log "优雅停止超时，强制终止"
            pids=$(ss -lntp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | sort -u || true)
            for p in $pids; do kill -9 "$p" 2>/dev/null || true; done
            sleep 2
        fi
    fi
    ss -lntp 2>/dev/null | grep -q ":$PORT " && die "端口 $PORT 仍被占用，无法启动新版本"
    return 0
}

start_backend() { # version
    local version="$1"
    cd "$CURRENT" || die "current 目录不可用"
    # 版本注入：DeploymentProbeFilter 读 APP_VERSION / GIT_COMMIT 环境变量
    #
    # ⚠️ 关键：`9>&-` 关闭 fd 9（发布锁）。
    #    acquire_lock 用 `exec 9>"$LOCK"` 打开锁文件，nohup 启动的后端进程
    #    **默认继承所有 fd**，于是长期持锁 → 下次发布必报
    #    「已有发布任务运行中」，且锁永远不释放（因为服务常驻）。
    #    实测踩到：flock 被健康运行的 java 进程持有，导致后续部署全部失败。
    APP_VERSION="$version" GIT_COMMIT="$version" \
      FLOWABLE_ENABLED=true \
      nohup "$JAVA" -jar schema-platform.jar \
        --server.port=$PORT \
        --spring.datasource.url="$DB_URL" \
        --spring.datasource.username="$DB_USER" \
        --spring.datasource.password="$DB_PASS" \
        --flowable.process.enabled=true \
        > "$ROOT/backend.log" 2>&1 9>&- &
    log "已启动 PID=$!（版本 $version，已关闭从父进程继承的锁 fd）"
}

switch_to() { # version
    local version="$1"
    ln -sfn "$RELEASES/$version" "$CURRENT"
    # 静态目录按应用软链（nginx alias 直指这三个路径）
    for app in designer runtime admin; do
        rm -rf "$ROOT/$app"
        ln -sfn "$CURRENT/web/$app" "$ROOT/$app"
    done
    stop_backend
    start_backend "$version"
}

cmd_upload() {
    local version="${1:?version required}"
    require_root
    acquire_lock
    ingest_from_stream "$version" -
}

# 从文件入库（CI 用 scp 先上传的场景：避免大块 stdin 管道在公网挂住）
#
# 用法：
#   ingest <version> <web-or-full-tar>                    # 单包（旧形式，web+jar 齐全）
#   ingest <version> <web-tar> <backend-tar>              # 分离包（web 含 MANIFEST/VERSION）
#   ingest <version> <web-tar> -                          # 分离包，但复用上一版本的 jar
#
# 分离传输的由来（实测）：jar 34.5MB（gzip 后仍 30.9MB，它是 zip 压不动），
# web 5MB（gzip 后 1.86MB）。纯前端改动只需传 1.86MB → 秒级完成。
cmd_ingest() {
    local version="${1:?version required}"
    local web_tar="${2:?web tar required}"
    local backend_tar="${3:-}"

    require_root
    acquire_lock
    [ -f "$web_tar" ] || die "web tar 不存在: $web_tar"

    local dest="$RELEASES/$version"
    [ -e "$dest" ] && die "版本已存在: $dest（不可覆盖——请用新版本号，或人工确认后先删）"

    mkdir -p "$STAGING" "$RELEASES"
    local tmp="$STAGING/$version.$"
    rm -rf "$tmp"; mkdir -p "$tmp"

    # ① web 包：含 web/ + VERSION.txt + MANIFEST.sha256
    log "解包 web 包: $web_tar ($(du -h "$web_tar" | cut -f1))"
    tar -xzf "$web_tar" -C "$tmp" || { rm -rf "$tmp"; die "web 包解包失败"; }

    # ② jar：三态
    if [ -z "$backend_tar" ]; then
        # 单包模式（旧形式）：jar 应已在 web 包里
        [ -f "$tmp/schema-platform.jar" ] || {
            rm -rf "$tmp"; die "单包模式但缺 schema-platform.jar"; }
        log "单包模式：jar 来自 web 包"
    elif [ "$backend_tar" = "-" ]; then
        # 复用上一版本 jar（纯前端改动）
        local prev; prev=$(read_state current)
        [ -n "$prev" ] || { rm -rf "$tmp"; die "无上一版本可供复用 jar"; }
        [ -f "$RELEASES/$prev/schema-platform.jar" ] || {
            rm -rf "$tmp"; die "上一版本 $prev 无 jar 可复用"; }
        cp -f "$RELEASES/$prev/schema-platform.jar" "$tmp/schema-platform.jar"
        log "复用上一版本 jar: $prev"
    else
        [ -f "$backend_tar" ] || { rm -rf "$tmp"; die "backend tar 不存在: $backend_tar"; }
        log "解包 backend 包: $backend_tar ($(du -h "$backend_tar" | cut -f1))"
        tar -xf "$backend_tar" -C "$tmp" || { rm -rf "$tmp"; die "backend 包解包失败"; }
        [ -f "$tmp/schema-platform.jar" ] || { rm -rf "$tmp"; die "backend 包缺 schema-platform.jar"; }
    fi

    # ③ MANIFEST 校验（web 包内的清单；jar 单独校验见下）
    if [ -f "$tmp/$MANIFEST" ]; then
        (cd "$tmp" && sha256sum -c "$MANIFEST" --quiet 2>/dev/null) || {
            # jar 在分离模式下不在 MANIFEST 中，逐条校验允许"缺失"仅限 jar
            log "MANIFEST 含 jar 条目时的严格校验："
            (cd "$tmp" && sha256sum -c "$MANIFEST" --quiet) || {
                rm -rf "$tmp"; die "MANIFEST 校验失败——产物损坏"; }
        }
    else
        rm -rf "$tmp"; die "产物缺 $MANIFEST"
    fi

    # ④ 独立校验 jar（VERSION.txt 里记录了 jarSha256）
    if [ -f "$tmp/VERSION.txt" ]; then
        local expect actual
        expect=$(grep '^jarSha256=' "$tmp/VERSION.txt" | cut -d= -f2)
        actual=$(sha256sum "$tmp/schema-platform.jar" | cut -d' ' -f1)
        if [ -n "$expect" ] && [ "$expect" != "$actual" ]; then
            rm -rf "$tmp"; die "jar 哈希不匹配: VERSION=$expect 实际=$actual"
        fi
        log "jar 哈希校验通过: ${actual:0:16}..."
    fi

    [ -d "$tmp/web" ] || { rm -rf "$tmp"; die "产物缺 web/"; }

    # 迁移水位入库
    local highest=0 v
    for v in $(unzip -l "$tmp/schema-platform.jar" 2>/dev/null | grep -o 'db/migration/V[0-9]*__' | grep -o 'V[0-9]*' | tr -d 'V' | sort -n); do
        highest=$v
    done
    echo "$highest" > "$tmp/dbBaseline"

    chown -R root:root "$tmp"
    chmod 755 "$tmp"; chmod 640 "$tmp/schema-platform.jar"
    find "$tmp/web" -type d -exec chmod 755 {} +
    find "$tmp/web" -type f -exec chmod 644 {} +
    mv "$tmp" "$dest"
    log "入库完成: $version ($(du -sh "$dest" | cut -f1)) dbBaseline=$highest"
}

# 共用入库逻辑：$2 是 tar 路径（- 表示 stdin）
ingest_from_stream() {
    local version="$1"
    local source="$2"
    local dest="$RELEASES/$version"
    if [ -e "$dest" ]; then
        die "版本已存在: $dest（不可覆盖——请用新版本号，或人工确认后先删）"
    fi
    mkdir -p "$STAGING" "$RELEASES"
    local tmp="$STAGING/$version.$"
    rm -rf "$tmp"; mkdir -p "$tmp"
    log "接收产物流 -> $tmp"

    if [ "$source" = "-" ]; then
        tar -xzf - -C "$tmp" || { rm -rf "$tmp"; die "产物解包失败"; }
    else
        log "从文件解包: $source ($(du -h "$source" | cut -f1))"
        tar -xzf "$source" -C "$tmp" || { rm -rf "$tmp"; die "产物解包失败"; }
    fi
    if [ ! -f "$tmp/$MANIFEST" ]; then
        rm -rf "$tmp"; die "产物缺 $MANIFEST——拒绝入库"
    fi
    (cd "$tmp" && sha256sum -c "$MANIFEST" --quiet) || {
        rm -rf "$tmp"; die "MANIFEST 校验失败——产物损坏，拒绝入库"
    }
    [ -f "$tmp/schema-platform.jar" ] || { rm -rf "$tmp"; die "产物缺 schema-platform.jar"; }
    [ -d "$tmp/web" ] || { rm -rf "$tmp"; die "产物缺 web/"; }

    # 迁移水位入库（供回滚边界判断）
    local highest=0 v
    for v in $(unzip -l "$tmp/schema-platform.jar" 2>/dev/null | grep -o 'db/migration/V[0-9]*__' | grep -o 'V[0-9]*' | tr -d 'V' | sort -n); do
        highest=$v
    done
    echo "$highest" > "$tmp/dbBaseline"

    # 权限：deploy 无法写入此目录，全部归 root；nginx 需要可读
    chown -R root:root "$tmp"
    chmod 755 "$tmp"; chmod 640 "$tmp/schema-platform.jar"
    find "$tmp/web" -type d -exec chmod 755 {} +
    find "$tmp/web" -type f -exec chmod 644 {} +
    mv "$tmp" "$dest"
    log "上传入库完成: $version ($(du -sh "$dest" | cut -f1)) dbBaseline=$highest"
}

cmd_switch() {
    local version="${1:?version required}"
    require_root
    acquire_lock
    [ -d "$RELEASES/$version" ] || die "版本不存在: $RELEASES/$version"
    local prev; prev=$(read_state current)
    backup_db
    log "切换版本 ${prev:-<首次>} -> $version（库水位 v$(db_current)）"
    switch_to "$version"
    if verify_release "$version"; then
        write_state "$version" "${prev:-}"
        log "发布成功: $version"
    else
        log "发布失败——自动回滚到 ${prev:-无}"
        if [ -n "$prev" ] && [ -d "$RELEASES/$prev" ]; then
            switch_to "$prev" || true
            if verify_release "$prev"; then
                log "已回滚到 $prev（验证通过）"
            else
                die "回滚后验证仍失败——人工介入: $ROOT/backend.log"
            fi
        else
            die "无可用上一版本——人工介入: $ROOT/backend.log"
        fi
        exit 1
    fi
}

cmd_status() {
    echo "== current -> $(readlink -f "$CURRENT" 2>/dev/null || echo '<无>')"
    [ -f "$STATE" ] && cat "$STATE"
    echo "== 库迁移水位: v$(db_current)"
    echo "== 后端: $(ss -lntp 2>/dev/null | grep ":$PORT " >/dev/null && echo "运行中(端口 $PORT)" || echo 未运行)"
    echo "== probe: $(probe_json)"
    echo "== releases:"
    for d in $(ls -1t "$RELEASES" 2>/dev/null | head -5); do
        echo "  $d (dbBaseline=v$(cat "$RELEASES/$d/dbBaseline" 2>/dev/null || echo '?'))"
    done
    echo "== disk: $(df -h "$ROOT" | tail -1)"
}

case "${1:-}" in
    upload) shift; cmd_upload "$@" ;;
    ingest) shift; cmd_ingest "$@" ;;
    switch) shift; cmd_switch "$@" ;;
    status) cmd_status ;;
    *) sed -n '2,20p' "$0"; exit 2 ;;
esac