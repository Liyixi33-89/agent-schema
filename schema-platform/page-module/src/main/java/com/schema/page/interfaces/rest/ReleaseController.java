package com.schema.page.interfaces.rest;

import com.schema.page.application.PageCommandService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 发布/回滚（04BE §A.2）+ 运行时读取（04BE §A.4 ETag 协议）。
 * 运行时读取独立无 /api/pages 前缀（运行时容器消费面与设计器分离）。
 */
@RestController
public class ReleaseController {

    private final PageCommandService service;

    public ReleaseController(PageCommandService service) {
        this.service = service;
    }

    // ---------- §A.2 发布与回滚 ----------

    @PostMapping("/api/apps/{appId}/publish")
    public Map<String, Object> publish(@PathVariable long appId, @RequestBody Map<String, Object> body) {
        List<Long> pageIds = null;
        if (body.get("pageIds") instanceof List<?> raw) {
            pageIds = new ArrayList<>();
            for (Object o : raw) {
                pageIds.add(Long.parseLong(String.valueOf(o)));
            }
        }
        String changelog = body.get("changelog") instanceof String c ? c : null;
        return service.publish(appId, pageIds, changelog);
    }

    @GetMapping("/api/apps/{appId}/releases")
    public Map<String, Object> releases(@PathVariable long appId) {
        return service.listReleases(appId);
    }

    @PostMapping("/api/apps/{appId}/rollback")
    public Map<String, Object> rollback(@PathVariable long appId, @RequestBody Map<String, Object> body) {
        int target = body.get("targetReleaseVersion") instanceof Number n ? n.intValue()
                : Integer.parseInt(String.valueOf(body.get("targetReleaseVersion")));
        return service.rollback(appId, target);
    }

    // ---------- §A.4 运行时读取（ETag） ----------

    @GetMapping("/api/runtime/pages/{pageId}")
    public ResponseEntity<Map<String, Object>> runtimePage(@PathVariable long pageId,
            @RequestHeader(value = "If-None-Match", required = false) String ifNoneMatch) {
        PageCommandService.RuntimePage page = service.getPublished(pageId,
                normalize(ifNoneMatch));
        if (page.notModified()) {
            return ResponseEntity.status(304).header("ETag", quoted(page.etag())).build();
        }
        return ResponseEntity.ok().header("ETag", quoted(page.etag()))
                .header("Cache-Control", "private, must-revalidate")
                .body(page.schema());
    }

    private static String normalize(String etag) {
        if (etag == null) {
            return null;
        }
        return etag.trim().replaceAll("^\"|\"$", "");
    }

    private static String quoted(String etag) {
        return "\"" + etag + "\"";
    }
}
