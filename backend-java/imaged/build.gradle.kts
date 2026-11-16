// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

plugins {
    id("backend.java-conventions")
    application
}

// The images (JAVA-BACKEND.md §5, §19): a small program of its own that runs `vips thumbnail`
// in a process per image, so C code on a hostile image never runs inside the main JVM. It
// depends on no other module: a crash or an exploit dies with it.
dependencies {
    implementation(libs.jackson.databind)
    // R2 speaks S3: the SDK with the plain JDK HTTP client, without Netty and Apache
    implementation(platform(libs.aws.bom))
    implementation(libs.aws.s3) {
        exclude(group = "software.amazon.awssdk", module = "apache-client")
        exclude(group = "software.amazon.awssdk", module = "netty-nio-client")
    }
    implementation(libs.aws.url.client)
    implementation(libs.slf4j.api)
    runtimeOnly(libs.logback.classic)
    testImplementation(libs.testcontainers.junit)
}

application {
    mainClass = "masterkey.imaged.Main"
}
