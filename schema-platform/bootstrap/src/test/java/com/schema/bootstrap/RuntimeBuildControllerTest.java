package com.schema.bootstrap;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import org.junit.jupiter.api.Test;

class RuntimeBuildControllerTest {
    @Test
    void uninstrumentedBuildCannotClaimVerifiedSource() {
        RuntimeBuildController controller = new RuntimeBuildController(null);
        var first = controller.identity();
        var second = controller.identity();
        assertEquals(503, first.getStatusCode().value());
        assertNotNull(first.getBody());
        assertEquals(false, first.getBody().get("verifiable"));
        assertEquals(first.getBody().get("instanceId"), second.getBody().get("instanceId"));
    }
}
