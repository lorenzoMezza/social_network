// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

plugins {
    id("backend.java-conventions")
}

dependencies {
    api(libs.jackson.databind)
    testImplementation(libs.jqwik)
}
