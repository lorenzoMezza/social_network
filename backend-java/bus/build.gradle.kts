// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

plugins {
    id("backend.java-conventions")
}

// How the roles tell each other things (JAVA-BACKEND.md §6): an interface, the in-process
// version for one machine, NATS when the roles run on more.
dependencies {
    api(project(":core"))
    implementation(libs.slf4j.api)
}
