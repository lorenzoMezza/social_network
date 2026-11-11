# UnnamedApp

<p align="center">
  <b>A social map for meeting people at the events around you, in person.</b><br>
  A live 3D map of your neighbourhood: the people around you walk on it as their avatars, and
  anyone can pin an event that everyone nearby sees as a beam of light.
</p>

<p align="center">
  <a href="https://lorenzomezza.github.io/social_network/"><img src="https://img.shields.io/badge/See%20the%20showcase%20site-316CEE?style=for-the-badge" alt="See the showcase site"></a>
  &nbsp;
  <a href="https://lorenzomezza.github.io/social_network/demo/"><img src="https://img.shields.io/badge/Try%20the%20beta%20in%20your%20browser-F5B544?style=for-the-badge" alt="Try the beta in your browser"></a>
</p>

<p align="center">
  <b>Showcase site:</b> <a href="https://lorenzomezza.github.io/social_network/">lorenzomezza.github.io/social_network</a>
  · videos of every feature, how it's built, and the app to try in the browser
</p>

<p align="center">
  <img src="docs/images/people.gif" width="200" alt="Tapping someone walking on the map: the camera flies over and a wave goes out">
  <img src="docs/images/flash.gif" width="200" alt="A new flash event and its beam of light rising over the spot">
  <img src="docs/images/spot.gif" width="200" alt="Tapping a beam of light: the camera flies to the event and its page opens">
  <img src="docs/images/storm.gif" width="200" alt="A storm rolling in at night over the map">
</p>

iOS and Android, built end to end: the mobile app, the real-time 3D map and the backend behind
them.

## What it does

| | |
|:---:|---|
| <img src="docs/images/map.jpg" width="170" alt="The 3D map at noon"> | **Your neighbourhood, live in 3D.** Real streets from OpenStreetMap, drawn like a model you can turn in your hand, at the real hour and in the real weather. |
| <img src="docs/images/people.jpg" width="170" alt="A person's card with gestures"> | **See who's out, right now.** The people around you walk on the map where they really are. Wave, say hi, or say something to everyone nearby. Visible, approximate or invisible: you choose each time you open the map. |
| <img src="docs/images/event-page.jpg" width="170" alt="An event page with its cover photo"> | **Anyone can put an event on the map.** A flash event with a long press, or a planned one with photos and a description. The organizer chooses how far it reaches (100 to 800 m), how its beam moves, its colours and the look of its page. |
| <img src="docs/images/events.jpg" width="170" alt="The list of events around"> | **You only see what reaches you.** On the map as beams of light, and in one list: what's on now at the top, the ones your friends are going to marked. |
| <img src="docs/images/connect.jpg" width="170" alt="The code to connect in person"> | **Meet first, connect after.** No search and no friend requests: one phone shows a code, the other scans it. Everyone you're connected with is someone you actually met. |
| <img src="docs/images/chats.jpg" width="170" alt="Chats and groups"> <img src="docs/images/album.jpg" width="170" alt="An event's shared album"> | **The plan before, the photos after.** Chats, groups and polls, a chat for every event you join, and a shared album where everyone who went adds their pictures. |
| <img src="docs/images/avatar.jpg" width="170" alt="The avatar editor"> <img src="docs/images/profile.jpg" width="170" alt="A styled profile"> | **Show up as you.** A 3D avatar built from hundreds of pieces walks for you on the map, and your profile shows it the way you style it. |

## How it's built

Three codebases that talk to each other: the mobile app, the 3D map that runs inside it, and
the backend behind both. The map and the avatars rely on no outside provider: there is no map
SDK, tile service or avatar platform underneath, only open data and open-source parts.

| Folder | What it is |
|---|---|
| [`src/`](src) | The mobile app: Expo, React Native, Expo Router |
| [`webview/map/`](webview/map) | The 3D map: three.js inside a WebView, with its own shaders for sky, weather and light |
| [`webview/three-geo-play/`](webview/three-geo-play) | The library that turns vector tiles into the 3D city |
| [`webview/avatar/`](webview/avatar) | The 3D avatar viewer and editor |
| [`backend-java/`](backend-java) | The production backend: Java 25, Spring Boot, PostgreSQL + PostGIS, object storage, push |
| [`backend/`](backend) | The development backend (Python, FastAPI): the reference for how the server behaves |
| [`avatar-server/`](avatar-server), [`asset-pipeline/`](asset-pipeline) | The avatar catalog, files recompressed for each phone's GPU, and each look baked for the map |
| [`tile-provider/`](tile-provider) | Cuts OpenStreetMap data into PMTiles and serves them |
| [`docs/`](docs) | The app-backend contract ([`API.md`](docs/API.md)), the production backend design, promotions, the connection protocol, the art direction |
| [`legal/`](legal) | Privacy policy, terms and third-party notices (drafts) |
| [`show-case/`](show-case) | The showcase site, its videos and the in-browser demo |

Some of the choices, in short:

- **Positions are never stored.** They travel over one WebSocket, live only in the server's
  memory and are dropped a minute after you leave the map.
- **Connections only in person**, with single-use codes that change every few seconds; the
  server checks distance and blocks.
- **A crowd costs a handful of draw calls**: every avatar look is baked once into one mesh and
  one texture atlas.
- **Tests for every part**: the app, the map library, the tile pipeline and both backends
  (`make test`).

## Try it

- **On the web:** the [showcase site](https://lorenzomezza.github.io/social_network/) has a video of every
  feature. [The beta](https://lorenzomezza.github.io/social_network/demo/) runs the
  real app code with its Python backend compiled to WebAssembly, in your tab. It is a web
  stand-in for a phone app, so expect rough edges.
- **On your computer:** `make dev` sets everything up and starts the servers and Expo (macOS or
  Linux, Node 24+, uv). The full guide, in Italian, is in
  [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Status

A beta: not in the stores yet. What is done in the production backend and what is left:
[`backend-java/STATO.md`](backend-java/STATO.md).

## License

Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved: see [`LICENSE`](LICENSE). Parts that
come from others (OpenStreetMap data, the Decentraland avatar assets, open-source packages) keep
their own licences.
