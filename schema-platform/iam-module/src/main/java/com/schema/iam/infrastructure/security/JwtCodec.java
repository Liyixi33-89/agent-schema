package com.schema.iam.infrastructure.security;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * 手写 JWT（HS256）——不引 jjwt/spring-security-oauth（依赖红线：最小依赖面）。
 * claim 集（03BE §3.2）：sub=userId, tenant=tenantId, typ=access|refresh, exp, jti。
 * 纪律：JWT 不含权限明细（防止权限变更后仍有效——逐请求走判定链）。
 */
@Component
public class JwtCodec {

    public static final long ACCESS_TTL_SECONDS = 2 * 3600;      // 2h（03BE §4）
    public static final long REFRESH_TTL_SECONDS = 7 * 24 * 3600; // 7d

    private static final SecureRandom RANDOM = new SecureRandom();

    private final byte[] secret;

    public JwtCodec(@Value("${iam.jwt-secret:dev-only-secret-change-me-32bytes-min}") String secret) {
        if (secret == null || secret.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IllegalStateException("iam.jwt-secret 必须 ≥32 字节");
        }
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
    }

    public record Claims(Long userId, Long tenantId, String tokenType, long expiresAtEpoch, String jti) {
    }

    public String issueAccess(long userId, long tenantId) {
        return issue(userId, tenantId, "access", ACCESS_TTL_SECONDS);
    }

    public String issueRefresh(long userId, long tenantId) {
        return issue(userId, tenantId, "refresh", REFRESH_TTL_SECONDS);
    }

    private String issue(long userId, long tenantId, String type, long ttlSeconds) {
        long now = System.currentTimeMillis() / 1000;
        String header = b64url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String payload = b64url(("{\"sub\":\"" + userId + "\",\"tenant\":" + tenantId
                + ",\"typ\":\"" + type + "\",\"iat\":" + now
                + ",\"exp\":" + (now + ttlSeconds)
                + ",\"jti\":\"" + randomToken() + "\"}").getBytes(StandardCharsets.UTF_8));
        String signingInput = header + "." + payload;
        return signingInput + "." + b64url(hmac(signingInput));
    }

    /** 验签 + 过期解析；签名不合法/过期/结构非法返回 null（调用方统一 401 处理）。 */
    public Claims verify(String token) {
        if (token == null) {
            return null;
        }
        String[] parts = token.split("\\.");
        if (parts.length != 3) {
            return null;
        }
        String signingInput = parts[0] + "." + parts[1];
        if (!MessageDigest.isEqual(hmac(signingInput), b64urlDecode(parts[2]))) {
            return null;
        }
        String json = new String(b64urlDecode(parts[1]), StandardCharsets.UTF_8);
        // 手工解析固定 claim 结构（自身签发的固定形态，无需通用 JSON 解析）
        Long userId = extractNumber(json, "\"sub\":\"");
        Long tenantId = extractNumber(json, "\"tenant\":");
        String typ = extractString(json, "\"typ\":\"");
        Long exp = extractNumber(json, "\"exp\":");
        if (userId == null || tenantId == null || typ == null || exp == null) {
            return null;
        }
        if (exp < System.currentTimeMillis() / 1000) {
            return null;
        }
        return new Claims(userId, tenantId, typ, exp, extractString(json, "\"jti\":\""));
    }

    /** refresh token 原文生成（非 JWT——随机串；库中存 SHA-256 摘要）。 */
    public static String newRefreshToken() {
        return randomToken();
    }

    /** refresh token 哈希（SHA-256，原文不落库）。 */
    public static String hashRefreshToken(String refreshToken) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return java.util.HexFormat.of().formatHex(
                    digest.digest(refreshToken.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String randomToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private byte[] hmac(String input) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return mac.doFinal(input.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String b64url(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static byte[] b64urlDecode(String s) {
        return Base64.getUrlDecoder().decode(s);
    }

    private static Long extractNumber(String json, String key) {
        int i = json.indexOf(key);
        if (i < 0) {
            return null;
        }
        int start = i + key.length();
        int end = start;
        boolean quoted = key.endsWith("\"");
        if (quoted) {
            end = json.indexOf('"', start);
            return Long.parseLong(json.substring(start, end));
        }
        while (end < json.length() && (Character.isDigit(json.charAt(end)))) {
            end++;
        }
        return Long.parseLong(json.substring(start, end));
    }

    private static String extractString(String json, String key) {
        int i = json.indexOf(key);
        if (i < 0) {
            return null;
        }
        int start = i + key.length();
        int end = json.indexOf('"', start);
        return json.substring(start, end);
    }
}
