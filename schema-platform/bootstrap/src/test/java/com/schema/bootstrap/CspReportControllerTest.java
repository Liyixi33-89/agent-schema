package com.schema.bootstrap;

import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class CspReportControllerTest {
    private final MockMvc mvc = createMvc();

    private static MockMvc createMvc() {
        var converter = new org.springframework.http.converter.json.MappingJackson2HttpMessageConverter();
        var converters = new java.util.ArrayList<org.springframework.http.converter.HttpMessageConverter<?>>();
        converters.add(converter);
        new CspJsonConfiguration().extendMessageConverters(converters);
        return MockMvcBuilders.standaloneSetup(new CspReportController())
                .setMessageConverters(converter).addFilters(new SecurityHeadersFilter()).build();
    }

    @Test
    void acceptsBrowserReportWithoutReturningSensitivePayload() throws Exception {
        mvc.perform(post("/api/security/csp-reports").contentType("application/csp-report")
                .content("{\"csp-report\":{\"effective-directive\":\"script-src\",\"document-uri\":\"https://example.test/?token=secret\"}}"))
                .andExpect(status().isNoContent())
                .andExpect(content().string(""))
                .andExpect(header().string("Cache-Control", "no-store"));
    }

    @Test
    void rejectsMalformedJson() throws Exception {
        mvc.perform(post("/api/security/csp-reports").contentType("application/csp-report").content("{"))
                .andExpect(status().isBadRequest());
    }
}
