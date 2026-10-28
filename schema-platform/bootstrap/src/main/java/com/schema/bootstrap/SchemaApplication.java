package com.schema.bootstrap;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication(scanBasePackages = "com.schema")
public class SchemaApplication {
    public static void main(String[] args) {
        SpringApplication.run(SchemaApplication.class, args);
    }
}
