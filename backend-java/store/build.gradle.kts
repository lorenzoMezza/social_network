// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import net.ltgt.gradle.errorprone.errorprone

plugins {
    id("backend.java-conventions")
    `java-test-fixtures`
}

// The database: Flyway migrations (the schema's source of truth), the classes jOOQ generates
// from them (committed, under src/generated), the transactions. Never Spring Boot here: a
// machine with the presence role alone uses it without a Spring context.
val codegen: SourceSet = sourceSets.create("codegen")

sourceSets {
    main {
        java.srcDir("src/generated/java")
    }
}

dependencies {
    api(project(":core"))
    api(libs.jooq)
    // jOOQ's Settings carry JAXB annotations: without the API javac warns on every use
    compileOnlyApi(libs.jakarta.xml.bind)
    // the same for the annotations of pgjdbc (PSQLException tells which constraint was broken)
    compileOnlyApi(libs.checker.qual)
    api(libs.spring.tx)
    api(libs.spring.jdbc)
    implementation(libs.flyway.core)
    implementation(libs.flyway.postgresql)
    implementation(libs.hikaricp)
    implementation(libs.slf4j.api)
    implementation(libs.postgresql)

    "codegenImplementation"(libs.jooq.codegen)
    "codegenImplementation"(libs.jooq.meta)
    "codegenImplementation"(libs.flyway.core)
    "codegenImplementation"(libs.flyway.postgresql)
    "codegenImplementation"(libs.testcontainers.postgresql)
    "codegenRuntimeOnly"(libs.postgresql)
    "codegenRuntimeOnly"(libs.logback.classic)

    testFixturesApi(libs.testcontainers.postgresql)
    testFixturesApi(libs.hikaricp)
    testFixturesCompileOnly(libs.jspecify)
    testRuntimeOnly(libs.logback.classic)
}

// The generator is a tool of the build, not of the server: no Error Prone, no NullAway
tasks.named<JavaCompile>("compileCodegenJava") {
    options.errorprone.enabled = false
    options.compilerArgs.remove("-Werror")
}

// ./gradlew :store:generateJooq — a PostGIS in Docker, the migrations, then jOOQ reads it.
// Run after adding a migration, and commit what changed under src/generated.
tasks.register<JavaExec>("generateJooq") {
    group = "build"
    description = "Generates the jOOQ classes from the Flyway migrations, on a PostGIS in Docker."
    classpath = codegen.runtimeClasspath
    mainClass = "masterkey.store.codegen.Generate"
    args(file("src/main/resources/db/migration").absolutePath, file("src/generated/java").absolutePath)
}
