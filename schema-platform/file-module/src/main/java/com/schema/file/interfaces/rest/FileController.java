package com.schema.file.interfaces.rest;

import com.schema.file.application.FileService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * 文件接口（11BE §A.1-A.2）：presign → 客户端直传 → complete；下载凭证；元数据；管理删除。
 */
@RestController
@RequestMapping("/api/files")
public class FileController {

    private final FileService service;

    public FileController(FileService service) {
        this.service = service;
    }

    @PostMapping("/presign")
    public Map<String, Object> presign(@RequestBody Map<String, Object> body) {
        return service.presign(str(body.get("fileName")), str(body.get("contentType")),
                num(body.get("size")), str(body.get("scope")),
                body.get("appId") == null ? null : numLong(body.get("appId")));
    }

    @PostMapping("/{fileId}/parts")
    public Map<String, Object> parts(@PathVariable long fileId, @RequestBody Map<String, Object> body) {
        return service.presignPart(fileId, (int) num(body.get("partNumber")));
    }

    @PostMapping("/{fileId}/complete")
    public ResponseEntity<Map<String, Object>> complete(@PathVariable long fileId,
            @RequestBody Map<String, Object> body) {
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> parts = (List<Map<String, Object>>) body.get("parts");
        Map<String, Object> resp = service.complete(fileId, parts, str(body.get("sha256")));
        return ResponseEntity.status(HttpStatus.CREATED).body(resp);
    }

    @GetMapping("/{fileId}/url")
    public Map<String, Object> downloadUrl(@PathVariable long fileId) {
        return service.downloadUrl(fileId);
    }

    @GetMapping("/{fileId}")
    public Map<String, Object> meta(@PathVariable long fileId) {
        return service.meta(fileId);
    }

    @DeleteMapping("/{fileId}")
    public Map<String, Object> delete(@PathVariable long fileId) {
        service.delete(fileId);
        return Map.of("deleted", true);
    }

    private static String str(Object v) {
        return v == null ? null : String.valueOf(v);
    }

    private static long num(Object v) {
        return v instanceof Number n ? n.longValue() : Long.parseLong(String.valueOf(v));
    }

    private static Long numLong(Object v) {
        return v instanceof Number n ? n.longValue() : Long.parseLong(String.valueOf(v));
    }
}
