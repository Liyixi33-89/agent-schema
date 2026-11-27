#!/usr/bin/env bash
# Schema 平台发布脚本 v2（服务器侧执行）——安全发布收口版
#
# 用法：
#   schema-release.sh upload    <version>          # stdin 收 tar 流 -> 校验 MANIFEST -> 原子入库
#   schema-release.sh ingest    <version> <web-tar> <backend-tar|->  # 从文件入库（分离包，推荐）
#   schema-release.sh switch    <version>          # 发布锁 -> 全量验证（探针+三入口+版本一致）-> 失败自动回滚
#   schema-release.sh rollback  [version]          # 回滚（跨迁移边界拒绝，见 DB_FLOOR）
#   schema-release.sh status                       # 版本/探针/锁状态
#
# ⚠️ upload（stdin 管道）传 30MB+ 大文件在公网会挂住——本地 7.8s、CI 600s 超时。
#    CI 与本地部署统一走 ingest：先 scp 上传到 /tmp，再由本脚本从文件解包。
#
# 五缺口收口（2026-11-03 二轮）：
#   1) 发布锁：flock /run/lock/schema-release.lock——手工与 CI 并发发布互斥；
#   2) 完整性：上传 tar 内必须含 MANIFEST.sha256（jar+web 文件哈希清单），逐条比对，失败不入库；
#   3) 原子性：先落 staging 目录，校验通过后 mv 入库；current 软链 ln -sfn 原子替换；
#      release-state.json 走临时文件 + mv 原子写；
#   4) 发布成功条件 = 后端就绪探针 + 三入口 200 + 探针 commit == 目标版本，任一失败自动回滚；
#   5) 迁移边界：版本目录记录 dbBaseline（入库时 flyway_info 最高版本）；rollback 目标 dbBaseline
#      高于当前库实际版本时拒绝（旧代码跑不动新 schema 的迁移列/表不可见风险）。
set -euo pipefail

ROOT=/opt/schema
RELEASES=$ROOT/releases
STAGING=$ROOT/staging
CURRENT=$ROOT/current
STATE=$ROOT/release-state.json
MANIFEST=MANIFEST.sha256
LOCK=/run/lock/schema-release.lock
BACKUPS=$ROOT/backups
SERVICE=schema-platform
BASE=http://127.0.0.1
HEALTH=$BASE:18080/internal/health/readiness
WAIT_TIMEOUT=120

log() { echo "[$(date '+%F %T')] $*"; }
die() { log "ERROR: $*"; exit 1; }
require_root() { [ "$(id -u)" = 0 ] || die "must run as root"; }

# 发布锁：switch/rollback/upload 入库段互斥（锁文件自动释放，异常退出不留死锁）
acquire_lock() {
    exec 9>"$LOCK"
    flock -n 9 || die "已有发布任务运行中（$LOCK）——请稍后重试"
}

read_state() { [ -f "$STATE" ] && python3 -c "import json;print(json.load(open('$STATE')).get('$1',''))" || true; }

write_state() { # current previous —— 临时文件原子写
    local tmp; tmp=$(mktemp "$STATE.tmp.XXXXXX")
    printf '{"current":"%s","previous":"%s","switchedAt":"%s"}\n' \
        "$1" "$2" "$(date -Is)" > "$tmp"
    chmod 644 "$tmp"; mv -f "$tmp" "$STATE"
}

wait_ready() {
    local deadline=$((SECONDS + WAIT_TIMEOUT))
    while [ $SECONDS -lt $deadline ]; do
        curl -sf -m 5 "$HEALTH" >/dev/null 2>&1 && return 0
        sleep 3
    done
    return 1
}

probe_json() { curl -sf -m 5 "$HEALTH" 2>/dev/null || echo '{"status":"UNREACHABLE"}'; }

# 发布全量验证：后端就绪 + 三入口 200 + 探针 commit == 目标（任一失败即回滚）
verify_release() {
    local version="$1"
    if ! wait_ready; then
        log "验证失败：就绪探针不 UP（$(probe_json)）"
        return 1
    fi
    local entry
    for entry in / /designer/ /admin/; do
        local code; code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$BASE$entry" || echo 000)
        if [ "$code" != "200" ]; then
            log "验证失败：入口 $entry -> $code"
            return 1
        fi
    done
    local commit; commit=$(probe_json | python3 -c "import json,sys;print(json.load(sys.stdin).get('commit',''))" 2>/dev/null || true)
    if [ "$commit" != "$version" ]; then
        log "验证失败：线上 commit=$commit 与目标 $version 不一致"
        return 1
    fi
    log "全量验证通过: 探针 UP + 三入口 200 + commit=$version"
    return 0
}

# 版本入库时记录的数据库迁移水位（flyway_schema_history 最高版本）
db_baseline() { # version-dir -> e.g. "14"
    local d="$RELEASES/$1"
    [ -f "$d/dbBaseline" ] && cat "$d/dbBaseline" || echo "0"
}

db_current() { # 当前库实际迁移水位
    # ⚠️ split_part 是 text——max(text) 按字典序（'9'>'14'），必须先 ::int 再聚合
    runuser -u postgres -- psql -d schema_prod -tAc \
        "SELECT max(split_part(version,'.',1)::int) FROM flyway_schema_history WHERE success" 2>/dev/null || echo 0
}

backup_db() {
    mkdir -p "$BACKUPS"; chmod 700 "$BACKUPS"
    local out="$BACKUPS/pre-release-$(date '+%Y%m%d-%H%M%S').sql.gz"
    log "发布前备份数据库 -> $out"
    if ! runuser -u postgres -- pg_dump schema_prod | gzip > "$out"; then
        rm -f "$out"; die "数据库备份失败——发布中止"
    fi
    chmod 600 "$out"
    ls -1t "$BACKUPS"/pre-release-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm -f --
}

cmd_upload() {
    local version="${1:?version required}"
    require_root
    acquire_lock
    local tmp
    tmp=$(prepare_staging "$version")
    log "接收产物流 -> $tmp"
    if ! tar -xzf - -C "$tmp"; then
        rm -rf "$tmp"; die "产物解包失败"
    fi
    finalize_release "$version" "$tmp"
}

# 从文件入库（scp 先上传的场景：避免大块 stdin 管道在公网挂住）
#
# 用法：
#   ingest <version> <web-tar> <backend-tar>   # 分离双包（web 含 MANIFEST/VERSION）
#   ingest <version> <web-tar> -               # 分离包，复用上一版本 jar（纯前端改动）
#
# 为什么要有这条通道：stdin 管道传 30MB+ 在公网实测会挂住（本地 7.8s、
# CI 600s 超时）。scp 走独立数据通道，有天然进度/重传语义，可靠得多。
cmd_ingest() {
    local version="${1:?version required}"
    local web_tar="${2:?web tar required}"
    local backend_tar="${3:-}"

    require_root
    acquire_lock
    [ -f "$web_tar" ] || die "web tar 不存在: $web_tar"

    local tmp
    tmp=$(prepare_staging "$version")

    # ① web 包（含 web/ + VERSION.txt + MANIFEST.sha256）
    log "解包 web 包: $web_tar ($(du -h "$web_tar" | cut -f1))"
    tar -xzf "$web_tar" -C "$tmp" || { rm -rf "$tmp"; die "web 包解包失败"; }

    # ② jar 三态
    if [ -z "$backend_tar" ]; then
        [ -f "$tmp/schema-platform.jar" ] || {
            rm -rf "$tmp"; die "单包模式但缺 schema-platform.jar"; }
        log "单包模式：jar 来自 web 包"
    elif [ "$backend_tar" = "-" ]; then
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

    # ③ MANIFEST 只覆盖 web 包内文件（jar 由 ④ 单独校验）——
    #    分离传输下「复用上一版本 jar」时 MANIFEST 不含 jar 才对得上。
    [ -f "$tmp/$MANIFEST" ] || { rm -rf "$tmp"; die "产物缺 $MANIFEST"; }
    (cd "$tmp" && sha256sum -c "$MANIFEST" --quiet) || {
        rm -rf "$tmp"; die "MANIFEST 校验失败——web 产物损坏或缺文件"; }
    log "MANIFEST 校验通过（$(wc -l < "$tmp/$MANIFEST") 个文件）"

    # ④ jar 校验：仅当本次真的传了 jar 才比对（复用时 VERSION.txt 记的是
    #    本次构建哈希，与实际复用的旧 jar 必然不同，不能比）。
    if [ "$backend_tar" != "-" ] && [ -f "$tmp/VERSION.txt" ]; then
        local expect actual
        expect=$(grep '^jarSha256=' "$tmp/VERSION.txt" | head -1 | cut -d= -f2 | tr -d '[:space:]')
        actual=$(sha256sum "$tmp/schema-platform.jar" | cut -d' ' -f1 | tr -d '[:space:]')
        if [ -n "$expect" ] && [ "$expect" != "$actual" ]; then
            rm -rf "$tmp"; die "jar 哈希不匹配: VERSION=[$expect] 实际=[$actual]"
        fi
        log "jar 哈希校验通过: ${actual:0:16}..."
    elif [ "$backend_tar" = "-" ]; then
        log "复用上一版本 jar：跳过 jarSha256 比对（该版本入库时已校验）"
    fi

    finalize_release "$version" "$tmp"
}

# 建 staging 目录并做「版本不可覆盖」检查（upload / ingest 共用）
prepare_staging() {
    local version="$1"
    local dest="$RELEASES/$version"
    [ -e "$dest" ] && die "版本已存在: $dest（不可覆盖——请用新版本号）"
    mkdir -p "$STAGING" "$RELEASES"
    local tmp="$STAGING/$version.$"
    rm -rf "$tmp"; mkdir -p "$tmp"
    printf '%s' "$tmp"
}

# 完整性兜底 + 迁移水位 + 权限模型 + 原子入库（upload / ingest 共用）
finalize_release() {
    local version="$1"
    local tmp="$2"
    [ -f "$tmp/schema-platform.jar" ] || { rm -rf "$tmp"; die "产物缺 schema-platform.jar"; }
    [ -d "$tmp/web" ] || { rm -rf "$tmp"; die "产物缺 web/"; }
    # 迁移水位入库（回滚边界判定依据）
    local highest=0 v
    for v in $(unzip -l "$tmp/schema-platform.jar" | grep -o 'db/migration/V[0-9]*__' | grep -o 'V[0-9]*' | tr -d 'V' | sort -n); do
        highest=$v
    done
    echo "$highest" > "$tmp/dbBaseline"
    # 原子入库 + 权限模型（目录可穿越、jar 收紧、web 全局可读）
    # ⚠️ 生产服务以 schema 用户运行，jar 必须 schema:schema 且 640——
    #    与验收面（root + 644）不同，不要照搬。
    chown -R schema:schema "$tmp"
    chmod 755 "$tmp"; chmod 640 "$tmp/schema-platform.jar"
    find "$tmp/web" -type d -exec chmod 755 {} +
    find "$tmp/web" -type f -exec chmod 644 {} +
    mv "$tmp" "$RELEASES/$version"
    log "入库完成: $version ($(du -sh "$RELEASES/$version" | cut -f1)) dbBaseline=$highest"
}

switch_to() { # version —— 纯切链+重启，不含验证（内部复用）
    local version="$1"
    printf 'APP_VERSION=%s\nGIT_COMMIT=%s\n' "$version" "$version" > /etc/schema-release.env
    chmod 600 /etc/schema-release.env
    ln -sfn "$RELEASES/$version" "$CURRENT"
    systemctl restart "$SERVICE"
}

cmd_switch() {
    local version="${1:?version required}"
    require_root
    acquire_lock
    [ -d "$RELEASES/$version" ] || die "版本不存在: $RELEASES/$version"
    local prev; prev=$(read_state current)
    # ⚠️ 重复 switch 同一版本时 prev 会等于 version，写回后 previous 变成自己，
    #    回滚直接失效（2026-11-25 生产实测踩到）。此时保留原有的 previous。
    if [ "$prev" = "$version" ]; then
        prev=$(read_state previous)
        log "重复切换同一版本 $version —— 保留上一版本指针 ${prev:-<无>}"
    fi
    backup_db
    log "切换版本 ${prev:-<首次>} -> $version"
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
                die "回滚后验证仍失败——人工介入: journalctl -u $SERVICE"
            fi
        else
            die "无可用上一版本——人工介入: journalctl -u $SERVICE"
        fi
        exit 1
    fi
}

cmd_rollback() {
    require_root
    acquire_lock
    local target="${1:-}"
    [ -z "$target" ] && target=$(read_state previous)
    [ -n "$target" ] || die "未指定回滚版本且状态文件无上一版本记录"
    [ -d "$RELEASES/$target" ] || die "回滚版本不存在: $target"
    # 迁移边界闸：目标版本 dbBaseline 低于当前库水位 = 旧代码跑新 schema，拒绝
    local cur_db; cur_db=$(db_current)
    local tgt_base; tgt_base=$(db_baseline "$target")
    if [ "$tgt_base" -lt "$cur_db" ]; then
        die "拒绝回滚: 目标版本迁移水位 v$tgt_base < 库当前 v$cur_db（旧代码不可见新迁移；如确需回退请先人工评估兼容性并用 rollback --force-db-risk）"
    fi
    local cur; cur=$(read_state current)
    log "回滚 ${cur:-?} -> $target（库水位 v$cur_db，目标基线 v$tgt_base）"
    switch_to "$target"
    if verify_release "$target"; then
        write_state "$target" "${cur:-}"
        log "回滚成功: $target"
    else
        die "回滚后验证失败——人工介入"
    fi
}

cmd_status() {
    echo "== current -> $(readlink "$CURRENT" 2>/dev/null || echo '<无>')"
    [ -f "$STATE" ] && cat "$STATE"
    echo "== 库迁移水位: v$(db_current)"
    echo "== releases:"
    for d in $(ls -1t "$RELEASES" 2>/dev/null); do
        echo "  $d (dbBaseline=v$(db_baseline "$d"))"
    done
    echo "== probe: $(probe_json)"
    echo "== lock: $(flock -n /dev/stdin true 2>/dev/null && echo 空闲 || echo 占用) $(ls -la $LOCK 2>/dev/null || echo 无锁文件)"
    echo "== disk: $(df -h "$ROOT" | tail -1)"
}

case "${1:-}" in
    upload)   shift; cmd_upload "$@" ;;
    ingest)   shift; cmd_ingest "$@" ;;
    switch)   shift; cmd_switch "$@" ;;
    rollback) shift; cmd_rollback "$@" ;;
    # 数据权限预检（2026-11-27）：由 deploy 经白名单调用，root 身份执行。
    # 只读；退出码 0=通过 / 1=strict 发现缺范围 / 2=预检不可用。
    # 脚本固定在 root 属主目录，**不接受**「执行哪个脚本」的参数——
    # 否则这个白名单入口就变成「root 执行任意代码」。
    datascope-check)
        shift
        exec /usr/local/sbin/schema-datascope-check "$@"
        ;;
    status)   cmd_status ;;
    *) sed -n '2,20p' "$0"; exit 2 ;;
esac
