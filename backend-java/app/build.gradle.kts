// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

plugins {
    id("backend.java-conventions")
    alias(libs.plugins.spring.boot)
}

// The executable: reads the roles and starts what they need; Spring only with api or worker.
dependencies {
    implementation(project(":core"))
    implementation(project(":bus"))
    implementation(project(":presence"))
    implementation(project(":gateway"))
    implementation(project(":auth"))
    implementation(project(":store"))
    implementation(project(":api"))
    implementation(project(":jobs"))
    implementation(libs.spring.boot.starter.webmvc) {
        exclude(group = "org.springframework.boot", module = "spring-boot-starter-tomcat")
    }
    implementation(libs.spring.boot.starter.jetty)
    implementation(libs.jetty.websocket.server)
    implementation(libs.caffeine)
    compileOnly(libs.jakarta.xml.bind)
    compileOnly(libs.checker.qual)

    testImplementation(libs.spring.boot.starter.test)
    testImplementation(testFixtures(project(":store")))
    testImplementation(libs.jetty.websocket.client)
    testImplementation(libs.nimbus.jose.jwt)
    testImplementation(libs.archunit)
}

springBoot {
    mainClass = "masterkey.app.Main"
}
