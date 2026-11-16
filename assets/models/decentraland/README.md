# Decentraland avatar animations

`locomotion/{idle,walk,jog,run}.json` are Decentraland's own idle, walk, jog and run, converted from the Unity clips of [`decentraland/unity-explorer`](https://github.com/decentraland/unity-explorer), commit `c2aa0ad79dd60a1b37a2619e0a7ab43f7de6a1b2`, `Explorer/Assets/DCL/AvatarRendering/AvatarShape/Assets/Animations/{Idle,Walk,Jog,Run}.anim`. The repository is licensed under Apache License 2.0; see [LICENSE](./LICENSE).

- The curves were sampled at 30 fps (Hermite, as Unity evaluates them) and mirrored from Unity's left-handed space to glTF's (positions `-x`, rotations `(x, -y, -z, w)`).
- They animate the `Avatar_*` bones of every Decentraland body shape directly: no retargeting. Only the hips keep a translation, so each body shape keeps its own proportions.
- Keyframes are reduced within 0.2° of rotation (0.15 cm for the hips): about a fifth of the sampled keys are left. A track is either one value (static) or `{ f: frame indices, v: values }`.
- `speed` is the ground speed of a gait (m/s, measured on the stance foot) and `phase` the part of its cycle where the left foot is furthest forward.

They are decoded by `webview/avatar/src/clips.js`, played by the map (`webview/map/src/scene/avatarLocomotion.js`) and, the idle, by the profile's avatar viewer (`webview/avatar/src/main.js`). Both WebView builds embed them, so nothing is fetched at runtime.
