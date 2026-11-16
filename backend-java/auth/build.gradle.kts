// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

plugins {
    id("backend.java-conventions")
}

// Who is calling: Logto's tokens checked locally with the JWKS (Nimbus), the ID token that
// names a new account, the minimum app version. No database here: what needs one (erased
// accounts, making the account) comes through small interfaces.
dependencies {
    api(project(":core"))
    implementation(libs.nimbus.jose.jwt)
    implementation(libs.caffeine)
    implementation(libs.slf4j.api)
}
