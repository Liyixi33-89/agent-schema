package com.schema.bootstrap;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication(scanBasePackages = "com.schema")
@EnableScheduling
public class SchemaApplication {
    public static void main(String[] args) {
        SpringApplication.run(SchemaApplication.class, args);
    }
}
