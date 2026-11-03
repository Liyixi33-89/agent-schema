package com.schema.iam.domain.repository;

import com.schema.iam.domain.model.PermissionPolicy.DataScope;
import com.schema.iam.domain.model.PermissionPolicy.Perm;
import com.schema.iam.domain.model.UserAccount;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * IAM 仓储接口（DIP：领域层定义契约，基础设施实现）。
 */
public interface IamRepository {

    // ---------- 用户 ----------

    Optional<UserAccount> findUser(long tenantId, String account);

    Optional<UserAccount> findUserById(long userId);

    void insertUser(UserAccount user);

    void updateUser(UserAccount user);       // 登录计数/锁定/改密/重置

    /** 登录失败计数原子递增（+1 并按阈值写锁定）；返回递增后计数——并发失败不丢计数。 */
    int incrementFailedAttempts(UserAccount user);

    boolean userExists(long tenantId, String account);

    // ---------- 角色/权限点 ----------

    /** 用户全部角色（租户级 + 应用级）角色行。 */
    List<Map<String, Object>> findRolesOfUser(long tenantId, long userId);

    /** 角色的全部权限点。 */
    List<Perm> findPermsOfRoles(List<Long> roleIds);

    /** 角色的行级数据范围。 */
    List<DataScope> findDataScopesOfRoles(List<Long> roleIds);

    /**
     * 模型级 FIELD 权限配置存在性（2026-10-30 三轮收口）：
     * 该模型上是否存在任意 FIELD 权限行（与用户/角色无关）——
     * data-engine 字段级默认拒绝的判定输入（已配置模型的未授权用户默认拒绝）。
     */
    boolean hasFieldPermRows(long tenantId, long modelId);

    /**
     * 应用级页面权限配置存在性（导航过滤默认拒绝判定输入，13BE §3.3）：
     * 任意角色的 PAGE:view 行即算已配置——与当前用户无关（默认放行/拒绝的分界判定）。
     */
    boolean hasPagePermRows(long tenantId, long appId);

    // ---------- 授权（A.3 成员授权） ----------

    /** 覆盖式授权：先清该用户在 app 的旧关联再写入新角色集（事务内）。 */
    void replaceUserRoles(long tenantId, long userId, long appId, List<Long> roleIds);

    List<Long> findRoleIdsOfApp(long tenantId, long appId);

    Optional<Long> findRoleId(long tenantId, long appId, String code);

    /** 角色 code（席位触限校验输入——设计能力角色判定 app_admin/developer）。 */
    String findRoleCode(long roleId);

    // ---------- 应用角色初始化（13BE §3.1：应用创建时初始化三个默认角色） ----------

    /** 幂等插入应用级角色（ON CONFLICT DO NOTHING）；返回角色 id。 */
    long ensureAppRole(long tenantId, long appId, String code, String name);

    /** 用户在某应用的角色 id 集合（成员列表/最后管理员保护判定输入）。 */
    List<Long> findRoleIdsOfUserInApp(long tenantId, long userId, long appId);

    /** 应用全部成员（user_id → 角色行；成员列表接口输入）。 */
    List<Map<String, Object>> findMembersOfApp(long tenantId, long appId);

    /** 用户在应用的角色 code 集（工作台 myRole 口径）。 */
    List<String> findRoleCodesOfUserInApp(long tenantId, long userId, long appId);

    /**
     * app 行锁（SELECT ... FOR UPDATE）：成员管理中「最后管理员判定 → 角色写入」的并发串行化锚点
     * （13BE §3.2——两个并发移除仅剩的管理员时防止双双放行造成孤儿应用）。
     * app 行缺失不报错（跨租户/不存在由调用方业务校验拦截）。
     */
    void lockAppRow(long tenantId, long appId);

    // ---------- 刷新令牌（03BE §4：滚动签发 + 黑名单吊销；v0.4 附 csrf 绑定） ----------

    void insertRefreshToken(long tenantId, long userId, String tokenHash, java.time.OffsetDateTime expiresAt);

    /**
     * 签发会话绑定 csrf（v0.4 §4.1）：刷新令牌行携带本次会话的 schema_csrf 值——
     * 双提交服务端比对真源（cookie 可能被多标签并发刷新滚动，库值跟随最后一次签发）。
     */
    void insertRefreshToken(long tenantId, long userId, String tokenHash,
            java.time.OffsetDateTime expiresAt, String csrfValue);

    boolean isRefreshTokenActive(String tokenHash);

    /** 刷新 token 归属行（user_id/tenant_id）——刷新时定位会话主人。 */
    Optional<Map<String, Object>> findRefreshRow(String tokenHash);

    /**
     * 原子吊销未吊销的 refresh（一次性消费语义）：
     * 条件 UPDATE 未吊销行并返回受影响行数——同一 token 并发刷新只有一个事务得到 1。
     */
    boolean consumeRefreshToken(String tokenHash);

    /**
     * v0.4 §4.1 并发刷新容忍：消费时间在 ±10s 容忍窗口内的重复请求按重放容忍处理
     * （多标签并发刷新不误踢）——返回该行最近一次消费时间，null = 未消费。
     */
    java.time.OffsetDateTime refreshConsumedAt(String tokenHash);

    /**
     * 容忍窗口内重放的「同一次轮换结果」缓存行（2026-11-03 收口）：
     * 首次消费成功时把本次签发的 refresh 哈希与 csrf 值暂存到消费行——窗口内重放
     * 直接用同一组轮换结果再签发（不再滚动新链，收敛多标签各自成链的发散）。
     */
    Optional<Map<String, Object>> findRotationOf(String tokenHash);

    /** 首次消费成功时写入轮换结果缓存（rotated_hash/rotated_csrf）。 */
    void recordRotation(String tokenHash, String rotatedHash, String rotatedCsrf);

    /** 吊销用户全部 refresh（改密/登出全部设备/停用）。 */
    void revokeAllRefreshTokens(long userId);

    void revokeRefreshToken(String tokenHash);

    /** 登出收口：吊销用户全部活跃（未吊销未过期）refresh——并发刷新滚动留下的其他链一并失效。 */
    void revokeActiveRefreshTokens(long userId);

    /** 过期行物理清理（refresh 自然过期后的垃圾行——调用时机：刷新路径顺带清理该用户的过期行）。 */
    int purgeExpiredRefreshTokens(long userId);

    /** 用户密码版本（v0.4 强失效：access claim 与库值比对）。 */
    int findPwdVersion(long userId);

    // ---------- 审计（03BE §6） ----------

    void insertAudit(String eventType, Long tenantId, Long userId, String resourceType,
            String resourceId, Map<String, Object> diff, String ip, String ua);
}
