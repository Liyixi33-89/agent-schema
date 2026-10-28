package com.schema.bootstrap;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import static org.junit.jupiter.api.Assertions.*;

class SecurityHeadersFilterTest {
    @Test
    void appliesApiHeadersWithoutEnforcingCsp() throws Exception {
        var request = new MockHttpServletRequest("GET", "/api/example");
        var response = new MockHttpServletResponse();
        new SecurityHeadersFilter().doFilter(request, response, (req, res) -> {});
        assertEquals("nosniff", response.getHeader("X-Content-Type-Options"));
        assertEquals("no-store", response.getHeader("Cache-Control"));
        assertNotNull(response.getHeader("Content-Security-Policy-Report-Only"));
        assertNull(response.getHeader("Content-Security-Policy"));
    }
}
