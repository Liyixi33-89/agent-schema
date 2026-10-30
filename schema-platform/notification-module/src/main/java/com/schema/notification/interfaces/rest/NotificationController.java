package com.schema.notification.interfaces.rest;

import com.schema.notification.application.NotificationService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 通知接口（12BE §A.1-A.3）：列表/未读数/已读/偏好。
 */
@RestController
@RequestMapping("/api/notifications")
public class NotificationController {

    private final NotificationService service;

    public NotificationController(NotificationService service) {
        this.service = service;
    }

    @GetMapping
    public Map<String, Object> list(@RequestParam(defaultValue = "false") boolean unreadOnly,
            @RequestParam(required = false) String bizType,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        return service.list(unreadOnly, bizType, page, size);
    }

    @GetMapping("/unread-count")
    public Map<String, Object> unreadCount() {
        return service.unreadCount();
    }

    @PostMapping("/{id}/read")
    public Map<String, Object> markRead(@PathVariable long id) {
        return service.markRead(id);
    }

    @PostMapping("/read-all")
    public Map<String, Object> markAllRead() {
        return service.markAllRead();
    }

    @GetMapping("/prefs")
    public Map<String, Object> pref() {
        return service.pref();
    }

    @PutMapping("/prefs")
    public Map<String, Object> savePref(@RequestBody Map<String, Object> prefs) {
        return service.savePref(prefs);
    }
}
