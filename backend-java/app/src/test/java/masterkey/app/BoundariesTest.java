// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import org.junit.jupiter.api.Test;

/**
 * The boundaries of JAVA-BACKEND.md §5 and the bans of §21, checked on the compiled classes of
 * every module (not on good will): presence and gateway without Spring, presence without a
 * database, core without frameworks; no {@code @Transactional}, no Java deserialization, no
 * {@code System.out}, no {@code java.util.Random}, no sleeping in the presence's thread.
 */
class BoundariesTest {

    static final JavaClasses CLASSES = new ClassFileImporter().withImportOption(ImportOption.Predefined.DO_NOT_INCLUDE_TESTS)
            .importPackages("masterkey");

    @Test
    void presenceAndGatewayNeverUseSpring() {
        noClasses().that().resideInAnyPackage("masterkey.presence..", "masterkey.gateway..", "masterkey.core..", "masterkey.bus..")
                .should().dependOnClassesThat().resideInAnyPackage("org.springframework..")
                .check(CLASSES);
    }

    @Test
    void presenceNeverTouchesTheDatabase() {
        noClasses().that().resideInAPackage("masterkey.presence..")
                .should().dependOnClassesThat().resideInAnyPackage("masterkey.store..", "org.jooq..", "java.sql..", "javax.sql..", "com.zaxxer..")
                .check(CLASSES);
    }

    @Test
    void coreHasNoFramework() {
        noClasses().that().resideInAPackage("masterkey.core..")
                .should().dependOnClassesThat().resideInAnyPackage("org.jooq..", "org.eclipse.jetty..", "masterkey.store..", "masterkey.api..",
                        "masterkey.presence..", "masterkey.gateway..")
                .check(CLASSES);
    }

    @Test
    void theLowerModulesNeverReachUp() {
        noClasses().that().resideInAnyPackage("masterkey.store..", "masterkey.auth..", "masterkey.presence..", "masterkey.gateway..", "masterkey.bus..")
                .should().dependOnClassesThat().resideInAnyPackage("masterkey.api..", "masterkey.jobs..", "masterkey.app..")
                .check(CLASSES);
        noClasses().that().resideInAPackage("masterkey.api..")
                .should().dependOnClassesThat().resideInAnyPackage("masterkey.jobs..", "masterkey.app..")
                .check(CLASSES);
    }

    @Test
    void transactionsAreTemplatesNeverAnnotations() {
        noClasses().should().dependOnClassesThat().haveFullyQualifiedName("org.springframework.transaction.annotation.Transactional")
                .orShould().dependOnClassesThat().haveFullyQualifiedName("jakarta.transaction.Transactional")
                .check(CLASSES);
    }

    @Test
    void nothingIsReadBackWithJavaSerialization() {
        noClasses().should().dependOnClassesThat().haveFullyQualifiedName("java.io.ObjectInputStream").check(CLASSES);
    }

    @Test
    void randomnessIsSecureAndLogsAreLogs() {
        noClasses().should().dependOnClassesThat().haveFullyQualifiedName("java.util.Random").check(CLASSES);
        // Only a Main may print, before logging exists (a configuration refused)
        noClasses().that().doNotHaveSimpleName("Main").should().accessField(System.class, "out")
                .orShould().accessField(System.class, "err").check(CLASSES);
    }

    @Test
    void thePresenceThreadNeverSleeps() {
        noClasses().that().resideInAPackage("masterkey.presence..").should().callMethod(Thread.class, "sleep", long.class)
                .orShould().callMethod(Thread.class, "sleep", java.time.Duration.class)
                .check(CLASSES);
    }
}
