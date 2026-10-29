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

    boolean userExists(long tenantId, String account);

    // ---------- 角色/权限点 ----------

    /** 用户全部角色（租户级 + 应用级）角色行。 */
    List<Map<String, Object>> findRolesOfUser(long tenantId, long userId);

    /** 角色的全部权限点。 */
    List<Perm> findPermsOfRoles(List<Long> roleIds);

    /** 角色的行级数据范围。 */
    List<DataScope> findDataScopesOfRoles(List<Long> roleIds);

    // ---------- 授权（A.3 成员授权） ----------

    /** 覆盖式授权：先清该用户在 app 的旧关联再写入新角色集（事务内）。 */
    void replaceUserRoles(long tenantId, long userId, long appId, List<Long> roleIds);

    List<Long> findRoleIdsOfApp(long tenantId, long appId);

    Optional<Long> findRoleId(long tenantId, long appId, String code);

    // ---------- 刷新令牌（03BE §4：滚动签发 + 黑名单吊销） ----------

    void insertRefreshToken(long tenantId, long userId, String tokenHash, java.time.OffsetDateTime expiresAt);

    boolean isRefreshTokenActive(String tokenHash);

    /** 刷新 token 归属行（user_id/tenant_id）——刷新时定位会话主人。 */
    Optional<Map<String, Object>> findRefreshRow(String tokenHash);

    /** 吊销用户全部 refresh（改密/登出全部设备/停用）。 */
    void revokeAllRefreshTokens(long userId);

    void revokeRefreshToken(String tokenHash);

    // ---------- 审计（03BE §6） ----------

    void insertAudit(String eventType, Long tenantId, Long userId, String resourceType,
            String resourceId, Map<String, Object> diff, String ip, String ua);
}
