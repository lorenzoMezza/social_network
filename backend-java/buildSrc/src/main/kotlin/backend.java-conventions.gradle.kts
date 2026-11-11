// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// What every module shares: JDK 25, the checks of JAVA-BACKEND.md §21 on from the first day
// (a warning fails the build: added later they would mean fixing thousands of lines), and
// JUnit. Generated code (jOOQ) is left out of the checks, never out of the build.
import net.ltgt.gradle.errorprone.CheckSeverity
import net.ltgt.gradle.errorprone.errorprone

plugins {
    `java-library`
    id("net.ltgt.errorprone")
}

val libs = the<VersionCatalogsExtension>().named("libs")
fun lib(alias: String) = libs.findLibrary(alias).get()

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}

// Versions of everything Spring Boot manages, in every module and source set (its BOM, never
// by hand): main, test, test fixtures, the jOOQ generator
configurations.matching {
    val name = it.name
    name.endsWith("Implementation") || name == "implementation" || name.endsWith("CompileOnly") || name == "compileOnly"
        || name.endsWith("RuntimeOnly") || name == "runtimeOnly" || name.endsWith("AnnotationProcessor") || name == "annotationProcessor"
}.configureEach {
    project.dependencies.add(name, project.dependencies.platform(lib("spring-boot-bom")))
}

dependencies {
    errorprone(lib("errorprone-core"))
    errorprone(lib("nullaway"))
    compileOnlyApi(lib("jspecify"))
    testCompileOnly(lib("jspecify"))

    testImplementation(lib("junit-jupiter"))
    testImplementation(lib("assertj"))
    testRuntimeOnly(lib("junit-launcher"))
}

tasks.withType<JavaCompile>().configureEach {
    options.release = 25
    options.encoding = "UTF-8"
    options.compilerArgs.addAll(listOf("-Xlint:all,-serial,-processing,-classfile", "-Werror", "-parameters"))
    options.errorprone {
        disableWarningsInGeneratedCode = true
        excludedPaths = ".*/(src|build)/generated/.*"
        // Nulls are checked at compile time: every package is @NullMarked
        check("NullAway", if (name.contains("Test")) CheckSeverity.OFF else CheckSeverity.ERROR)
        option("NullAway:OnlyNullMarked", "true")
        option("NullAway:JSpecifyMode", "true")
        option("NullAway:CheckOptionalEmptiness", "true")
    }
}

tasks.withType<Test>().configureEach {
    useJUnitPlatform()
    // Tests run in UTC and in a neutral language, like the servers (§21)
    systemProperty("user.timezone", "UTC")
    systemProperty("user.language", "en")
    jvmArgs("-XX:+EnableDynamicAgentLoading", "-Xshare:off")
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
