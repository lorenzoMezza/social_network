// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

plugins {
    id("backend.java-conventions")
}

// The sockets of the phones, with Jetty's own WebSocket API: never Spring (JAVA-BACKEND.md §5).
dependencies {
    api(project(":core"))
    api(project(":presence"))
    api(project(":bus"))
    api(libs.jetty.server)
    implementation(libs.jetty.websocket.server)
    implementation(libs.slf4j.api)
    testImplementation(libs.jetty.websocket.client)
    testRuntimeOnly(libs.logback.classic)
}
