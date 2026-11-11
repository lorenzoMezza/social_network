// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The production backend (docs/JAVA-BACKEND.md): one jar with roles, plus `imaged`.
// Module boundaries are checked by ArchUnit (app/src/test), not by good will.
rootProject.name = "masterkey-backend"

pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        mavenCentral()
    }
}

include(
    "core",      // ids, errors, text, JSON, time, distances, area points: no framework
    "bus",       // the bus between roles: in-process, NATS with more machines
    "presence",  // matching of people nearby: JDK and PH-Tree only, never Spring or a database
    "auth",      // Logto keys and tokens, minimum app version
    "store",     // Flyway migrations, jOOQ classes, transactions
    "gateway",   // the WebSocket, with Jetty's API: never Spring
    "api",       // Spring MVC: every REST route and its rules
    "jobs",      // db-scheduler jobs
    "app",       // main: reads the roles and starts what they need
    "imaged",    // images: a program apart, independent of the others
)
