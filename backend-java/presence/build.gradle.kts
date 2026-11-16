// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

plugins {
    id("backend.java-conventions")
}

// The matching of people nearby: the JDK and PH-Tree only. Never Spring, never a database
// (checked by ArchUnit in app): what it needs from outside comes through Directory.
dependencies {
    api(project(":core"))
    implementation(libs.phtree)
    implementation(libs.slf4j.api)
    testImplementation(libs.jqwik)
}
