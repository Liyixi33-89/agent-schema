package com.schema.bootstrap;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
public class CspReportController {
    private static final Logger LOG = LoggerFactory.getLogger(CspReportController.class);

    @PostMapping(value = "/api/security/csp-reports", consumes = {"application/csp-report", "application/json"})
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void report(@RequestBody Map<String, Object> body) {
        Object report = body.get("csp-report");
        if (report instanceof Map<?, ?> fields) {
            // Do not log URLs, source snippets or arbitrary client payloads.
            Object directive = fields.get("effective-directive");
            if (directive instanceof String value && value.matches("[a-z-]{1,64}")) {
                LOG.warn("CSP violation directive={}", value);
            }
        }
    }
}
