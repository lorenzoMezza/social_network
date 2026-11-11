// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

plugins {
    id("backend.java-conventions")
}

// The work that happens later or by itself (JAVA-BACKEND.md §6, §8): db-scheduler on Postgres,
// with its data in JSON (never Java serialization, §16). The rules are the api's; here only when
// they run, and that a run twice changes nothing more.
dependencies {
    api(project(":core"))
    api(project(":store"))
    api(project(":api"))
    api(libs.db.scheduler)
    compileOnly(libs.jakarta.xml.bind)
    compileOnly(libs.checker.qual)
    implementation(libs.jackson.databind)
    implementation(libs.slf4j.api)
    // Push straight to APNs (a JWT ES256, HTTP/2 of the JDK) and FCM (Google's OAuth for its service account)
    implementation(libs.nimbus.jose.jwt)
    implementation(libs.google.auth)

    testImplementation(testFixtures(project(":store")))
    testRuntimeOnly(libs.logback.classic)
}
