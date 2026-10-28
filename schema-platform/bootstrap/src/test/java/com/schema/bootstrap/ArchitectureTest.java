package com.schema.bootstrap;

import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.lang.ArchRule;
import org.junit.jupiter.api.Test;
import org.springframework.stereotype.Component;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ArchitectureTest {
    private static ArchRule domainRule() {
        return noClasses().that().resideInAPackage("..domain..")
                .should().dependOnClassesThat().resideInAnyPackage("org.springframework..", "org.apache.ibatis..")
                .allowEmptyShould(true);
    }

    @Test
    void productionDomainDoesNotDependOnFrameworks() {
        domainRule().check(new ClassFileImporter().importPackages("com.schema.metadata", "com.schema.data",
                "com.schema.page", "com.schema.flow", "com.schema.iam", "com.schema.integration", "com.schema.metering"));
    }

    @Test
    void frameworkDependencyIsRejected() {
        ArchRule rule = noClasses().that().haveSimpleName("InvalidDomain")
                .should().dependOnClassesThat().resideInAPackage("org.springframework..");
        assertThrows(AssertionError.class,
                () -> rule.check(new ClassFileImporter().importClasses(InvalidDomain.class)));
    }

    @Component
    static class InvalidDomain {}
}
