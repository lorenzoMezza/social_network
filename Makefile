# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

# Every command of the project:  make dev | build | test | kill | clean   (make help)
#
# Each setup step is a file target: it runs only when its output is missing or older
# than what it is made from (package.json, sources, requirements…), so a second
# `make dev` goes straight to the servers and Expo.

SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help dev setup tiles build build-android build-ios test map-bench map-bench-people demo site kill clean

# Metro, backend, map tiles, map in the browser (webview/map: npm run dev), avatars
PORTS := 8081 7777 8091 8092 8093

# Release builds talk to the servers of this Mac over the Wi-Fi (`make dev` running).
# Online endpoints need HTTPS and the Logto API resource: make build API_URL=https://… \
#   AVATAR_URL=https://… API_RESOURCE=https://… TILE_URL=https://… (the TileJSON of
#   tile-provider/'s tiles: the map has no other source)
LAN_IP     := $(shell ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null \
	|| ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
API_URL    ?= http://$(LAN_IP):7777/v1
AVATAR_URL ?= http://$(LAN_IP):8092
TILE_URL   ?= $(if $(filter https://%,$(API_URL)),,http://$(LAN_IP):8093/tiles.json)
API_RESOURCE ?= $(EXPO_PUBLIC_API_RESOURCE)
BUILD_ENV  := EXPO_NO_GIT_STATUS=1 EXPO_PUBLIC_API_URL=$(API_URL) EXPO_PUBLIC_AVATAR_URL=$(AVATAR_URL) \
	EXPO_PUBLIC_TILE_URL=$(TILE_URL) EXPO_PUBLIC_API_RESOURCE=$(API_RESOURCE)
# iOS: the first team of Xcode › Settings › Accounts
IOS_TEAM   ?= $(shell defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier 2>/dev/null | sed -n 's/.*teamID = \(.*\);/\1/p' | head -1)
# The Java backend (backend-java/, JAVA=1) runs on JDK 25 (macOS, then Linux locations)
JAVA25     := $(or $(shell /usr/libexec/java_home -v 25 2>/dev/null),$(firstword $(wildcard /usr/lib/jvm/*25*)))
# Android: Gradle needs JDK 17 (macOS, then Linux locations)
ANDROID_JAVA := $(or $(shell /usr/libexec/java_home -v 17 2>/dev/null),$(firstword $(wildcard /usr/lib/jvm/*17*)))
ANDROID_HOME ?= $(firstword $(wildcard $(HOME)/Library/Android/sdk $(HOME)/Android/Sdk))
# iPhone builds need Xcode, so macOS
MACOS      := $(filter Darwin,$(shell uname))

help:
	@echo "make dev     set up what is missing, restart the servers, start Expo for the development build"
	@echo "             PROD=1: the minified JavaScript of a release"
	@echo "             SIM_LOCATION=lat,lon: GPS of the iOS simulators (default Rome)"
	@echo "             TILES_AREA=…: map area made when tile-provider/output/ is empty (roma)"
	@echo "             JAVA=1: the Java backend of production (backend-java/, PostGIS in Docker) instead of the Python one"
	@echo "             NO_BACKEND=1: no backend (another server answers on 7777, started after this)"
	@echo "             Android first run: npx expo run:android (Logto does not work in Expo Go)"
	@echo "make build   release builds: build/app.apk (Android) and build/app.ipa (iPhone)"
	@echo "             online backend: API_URL=https://… AVATAR_URL=… API_RESOURCE=…"
	@echo "             also build-android / build-ios alone"
	@echo "make test    lint, tests of the app, backend, three-geo-play and tile-provider"
	@echo "             JAVA=1: the Java backend's build and tests too (Docker, a few minutes)"
	@echo "make map-bench  the map's speed, measured in Chrome (needs make dev running): GPU time"
	@echo "             per frame and per part, main thread, memory, events and people received"
	@echo "             REF=<commit>: that commit's map too, side by side"
	@echo "make map-bench-people  what each person more costs the map: CPU, GPU, GPU memory (COUNTS=0,50,100)"
	@echo "make demo    the whole app for a browser, in show-case/demo/ (the try-it of the showcase site):"
	@echo "             the backend runs in the page (Pyodide). Needs the avatar server (make dev)"
	@echo "             (.github/workflows/pages.yml publishes show-case/ on GitHub Pages: commit demo/)"
	@echo "make site    the showcase site on http://localhost:8099 (the demo needs a web server, not file://)"
	@echo "make kill    stop every server and Expo, free their ports"
	@echo "make clean   make kill, then delete everything git ignores (dependencies,"
	@echo "             avatars, backend data, native folders, builds)"

# --- Development -------------------------------------------------------------

dev: setup kill
	@$(if $(JAVA),cd backend-java && docker compose up -d --wait --quiet-pull >/dev/null)
	@node scripts/dev.mjs $(if $(PROD),--production) $(if $(SIM_LOCATION),--sim-location $(SIM_LOCATION)) $(if $(NO_BACKEND),--no-backend) \
		$(if $(JAVA),--java "$(JAVA25)")

setup: node_modules/.installed assets/webview/map.html assets/webview/avatar.html tiles \
	tile-provider/node_modules/.installed \
	backend/.venv/.installed avatar-server/library-astc/.done avatar-server/map-avatars/.done \
	$(if $(JAVA),backend-java/app/build/libs/app.jar)

# The processes listening on the ports: lsof (macOS), else ss (every Linux)
kill:
	@command -v lsof >/dev/null || command -v ss >/dev/null || { echo "lsof is missing: install it"; exit 1; }
	@pids=$$(for port in $(PORTS); do \
		if command -v lsof >/dev/null; then lsof -ti tcp:$$port -sTCP:LISTEN; \
		else ss -Hltnp "sport = :$$port" | grep -o 'pid=[0-9]*' | cut -d= -f2; fi; \
	done | sort -u); \
	if [ -z "$$pids" ]; then echo "No servers running."; exit 0; fi; \
	kill $$pids 2>/dev/null; \
	for i in $$(seq 50); do kill -0 $$pids 2>/dev/null || break; sleep 0.1; done; \
	kill -9 $$pids 2>/dev/null; \
	echo "Servers stopped, ports $(PORTS) free."

# Keeps .env files and signing keys (ignored so they are never committed), the tiles
# made in tile-provider/ with their downloads (its own make clean)
KEEP := .env .env*.local *.jks *.p8 *.p12 *.key *.mobileprovision *.pem \
	tile-provider/output/ tile-provider/output/** tile-provider/data/ tile-provider/data/**
clean: kill
	git clean -ffdX $(foreach path,$(KEEP),-e '!$(path)')

test: node_modules/.installed backend/.venv/.installed webview/three-geo-play/node_modules/.installed \
		tile-provider/node_modules/.installed
	npx expo lint
	node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./test/register.mjs --test --test-reporter=spec test/*.test.mjs
	npm --prefix webview/three-geo-play test
	$(MAKE) -C tile-provider test
	cd backend && .venv/bin/python -m pytest tests -q -p no:cacheprovider -W ignore::DeprecationWarning
	$(if $(JAVA),cd backend-java && ./gradlew build -q)

# --- Setup steps -------------------------------------------------------------

node_modules/.installed: package.json package-lock.json
	npm install
	@touch $@

# webview/map, webview/avatar, webview/three-geo-play, asset-pipeline
%/node_modules/.installed: %/package.json %/package-lock.json
	npm --prefix $* install
	@touch $@

# The two WebView pages, committed (app builds use them as they are)
WEBVIEW_SHARED := $(shell find webview/avatar/src webview/shared assets/models/decentraland avatar-server/shared -type f)
WEBVIEW_DEPS   := webview/map/node_modules/.installed webview/avatar/node_modules/.installed \
	webview/three-geo-play/node_modules/.installed

assets/webview/map.html: $(shell find webview/map/src webview/map/scripts webview/three-geo-play/src -type f) \
		$(WEBVIEW_SHARED) $(WEBVIEW_DEPS)
	npm --prefix webview/map run build

assets/webview/avatar.html: $(shell find webview/avatar/scripts -type f) $(WEBVIEW_SHARED) $(WEBVIEW_DEPS)
	npm --prefix webview/avatar run build

# The map's only tiles: the areas made in tile-provider/ (served by make dev). With
# none yet, TILES_AREA is made first: Planetiler in Docker (started on macOS if it is
# off), about three minutes for Rome. More areas: make -C tile-provider tiles AREA=…
TILES_AREA ?= roma
tiles:
	@ls tile-provider/output/*.pmtiles >/dev/null 2>&1 || { \
		echo "No map tiles yet: making $(TILES_AREA) in tile-provider/ (Docker)"; \
		$(MAKE) -C tile-provider tiles AREA=$(TILES_AREA); }

backend/.venv/.installed: backend/requirements.txt backend/requirements-dev.txt
	@command -v uv >/dev/null || { echo "uv is missing: brew install uv (macOS), curl -LsSf https://astral.sh/uv/install.sh | sh (Linux)"; exit 1; }
	cd backend && uv venv .venv --python 3.13 --allow-existing \
		&& uv pip install --python .venv/bin/python -r requirements.txt -r requirements-dev.txt
	@touch $@

# The Java backend as one jar (its Gradle finds a JDK 25 by itself), made again when a source changes
JAVA_SOURCES := $(shell find backend-java -path '*/build' -prune -o -path '*/.gradle' -prune -o -type f \
	\( -name '*.java' -o -name '*.kts' -o -name '*.toml' -o -name '*.sql' -o -name '*.properties' -o -name '*.xml' \) -print 2>/dev/null)
backend-java/app/build/libs/app.jar: $(JAVA_SOURCES)
	@[ -n "$(JAVA25)" ] || { echo "JDK 25 is missing (brew install --cask temurin@25, apt install openjdk-25-jdk)"; exit 1; }
	cd backend-java && ./gradlew :app:bootJar -q
	@touch $@

# Decentraland's avatar assets (~1.2 GB clone), classified into library/
avatar-server/source:
	node avatar-server/scripts/fetch-source.mjs

avatar-server/library/catalog.json: avatar-server/scripts/build-library.mjs | avatar-server/source
	node avatar-server/scripts/build-library.mjs

# GPU-ready copies (ASTC, meshopt): ~10 minutes the first time, then only what changed
PIPELINE := $(shell find asset-pipeline/src asset-pipeline/scripts -type f) asset-pipeline/node_modules/.installed

avatar-server/library-astc/.done: avatar-server/library/catalog.json $(PIPELINE)
	npm --prefix asset-pipeline run avatars
	@touch $@

# The presets' map avatars, ahead of time (the server makes the others on demand)
avatar-server/map-avatars/.done: avatar-server/library/catalog.json $(PIPELINE)
	npm --prefix asset-pipeline run map-avatars
	@touch $@

# --- Map benchmark -------------------------------------------------------------

# The map page the app ships, in Chrome at an iPhone's size, in a busy scene that is
# the same every run (webview/map/bench/): run it before and after a change
map-bench: webview/map/node_modules/.installed assets/webview/map.html
	@node webview/map/bench/bench.mjs $(if $(REF),--ref $(REF))

# How many people the map can show: the same map with more and more of them (people.mjs)
map-bench-people: webview/map/node_modules/.installed assets/webview/map.html
	@node webview/map/bench/people.mjs $(if $(COUNTS),--counts $(COUNTS))

# --- Try-it demo of the showcase site --------------------------------------------

# The Expo web build, the backend for Pyodide, the demo's avatars and tiles (build.mjs).
# Its address on the site is filled in when published (GitHub Pages) or served (make site).
demo: node_modules/.installed backend/.venv/.installed avatar-server/library/catalog.json
	node show-case/tools/web/build.mjs

# The showcase site as a host serves it: the try-it demo needs http(s), never file://
site:
	@node show-case/tools/serve-site.mjs

# --- Release builds ----------------------------------------------------------

build: build-android $(if $(MACOS),build-ios)
	@ls -lh build/app.*
	@$(if $(MACOS),:,echo "No build/app.ipa: iPhone builds need macOS")

build-android: node_modules/.installed assets/webview/map.html assets/webview/avatar.html
	@[[ "$(API_URL)" != http://:* ]] || { echo "No Wi-Fi address: set API_URL and AVATAR_URL"; exit 1; }
	@[[ "$(API_URL)" != https://* || -n "$(API_RESOURCE)" ]] || { echo "Set API_RESOURCE to the API audience registered in Logto"; exit 1; }
	@[ -n "$(TILE_URL)" ] || { echo "Set TILE_URL to the TileJSON of the tiles of tile-provider/"; exit 1; }
	@[ -n "$(ANDROID_JAVA)" ] || { echo "JDK 17 is missing (brew install --cask temurin@17, apt install openjdk-17-jdk)"; exit 1; }
	@[ -d "$(ANDROID_HOME)" ] || { echo "No Android SDK: install Android Studio or set ANDROID_HOME"; exit 1; }
	$(BUILD_ENV) npx expo prebuild --platform android --clean
	cd android && JAVA_HOME=$(ANDROID_JAVA) ANDROID_HOME=$(ANDROID_HOME) $(BUILD_ENV) \
		./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
	@mkdir -p build && cp android/app/build/outputs/apk/release/app-release.apk build/app.apk
	@echo "build/app.apk"

build-ios: node_modules/.installed assets/webview/map.html assets/webview/avatar.html
	@[ -n "$(MACOS)" ] || { echo "iPhone builds need macOS and Xcode"; exit 1; }
	@[[ "$(API_URL)" != http://:* ]] || { echo "No Wi-Fi address: set API_URL and AVATAR_URL"; exit 1; }
	@[[ "$(API_URL)" != https://* || -n "$(API_RESOURCE)" ]] || { echo "Set API_RESOURCE to the API audience registered in Logto"; exit 1; }
	@[ -n "$(TILE_URL)" ] || { echo "Set TILE_URL to the TileJSON of the tiles of tile-provider/"; exit 1; }
	@[ -n "$(IOS_TEAM)" ] || { echo "No Apple team: add your Apple ID in Xcode › Settings › Accounts"; exit 1; }
	$(BUILD_ENV) npx expo prebuild --platform ios --clean
	@rm -rf build/ios && mkdir -p build/ios
	@printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
		'<plist version="1.0"><dict><key>method</key><string>debugging</string>' \
		'<key>teamID</key><string>$(IOS_TEAM)</string><key>signingStyle</key><string>automatic</string></dict></plist>' \
		> build/ios/ExportOptions.plist
	workspace=$$(ls -d ios/*.xcworkspace | head -1); \
	$(BUILD_ENV) xcodebuild -quiet -workspace $$workspace \
		-scheme $$(basename $$workspace .xcworkspace) -configuration Release \
		-destination generic/platform=iOS -archivePath build/ios/app.xcarchive archive \
		DEVELOPMENT_TEAM=$(IOS_TEAM) CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates
	xcodebuild -quiet -exportArchive -archivePath build/ios/app.xcarchive -exportPath build/ios \
		-exportOptionsPlist build/ios/ExportOptions.plist -allowProvisioningUpdates
	@cp build/ios/*.ipa build/app.ipa && echo "build/app.ipa"
