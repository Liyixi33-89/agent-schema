package com.schema.bootstrap;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;

class FoundationTest {
    @Test
    void usesJava21() {
        assertEquals(21, Runtime.version().feature());
    }
}
