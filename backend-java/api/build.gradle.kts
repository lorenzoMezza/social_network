// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

plugins {
    id("backend.java-conventions")
}

// The REST of API.md with Spring MVC: controllers, rules and queries, by area
// (people, events, chats, notifications, promotions, media, privacy, moderation).
// Started by app with the api role; the HTTP tests that run it whole are in app.
dependencies {
    api(project(":core"))
    api(project(":auth"))
    api(project(":store"))
    api(project(":presence"))
    api(project(":bus"))
    api(libs.spring.webmvc)
    compileOnly(libs.jakarta.servlet)
    compileOnly(libs.jakarta.xml.bind)
    compileOnly(libs.checker.qual)
    implementation(libs.caffeine)
    implementation(libs.slf4j.api)
    // Purchases: the stores' own libraries (§16: an Apple chain of signatures is never checked by hand)
    implementation(libs.apple.store.server)
    implementation(libs.android.publisher)
    implementation(libs.google.auth)
    // R2 speaks S3: the SDK with the plain JDK HTTP client, without Netty and Apache
    implementation(platform(libs.aws.bom))
    implementation(libs.aws.s3) {
        exclude(group = "software.amazon.awssdk", module = "apache-client")
        exclude(group = "software.amazon.awssdk", module = "netty-nio-client")
    }
    implementation(libs.aws.url.client)
    testImplementation(libs.jakarta.servlet)
    testImplementation(libs.testcontainers.junit)
    testRuntimeOnly(libs.logback.classic)
}
