# Connecting in person

A connection (a friendship on the app) can only be made by two people standing
together: one phone shows a code, the other scans it. There is no other way: no
search, no request, no link, no invitation. This file is the contract between the
app (`protocol.js`, `useConnect.js`, `connectApi.js`) and the backend (`docs/API.md`,
implemented by the development server in `backend/`), which is the one that enforces
it: the app can be modified, the server cannot.

## Flow

1. **Host** (Social › Connect › My code) opens a session. The server answers with a
   token; the app shows it as a QR code (`masterkey://c/<token>`) and asks for a new
   one every 5 s, for as long as the screen is open and the app in front.
2. **Guest** (Social › Connect › Scan) reads the code and sends the token. The server
   checks it and connects the two; both phones show "Connected!" (the host's hears it
   over the WebSocket, `connection.created`; it asks its session only while the socket
   is down). The server records where they met: the event happening there, if any.

## "Connect" on someone

"Connect" on someone the user sees on the map (their card, a direct chat) sends
`connect.invite`; the server checks they are within 1 km of each other on the map, not
blocked or connected, at most one invitation per 10 s per pair and 30 per hour per person.
The one who invited shows My code; the other sees "<name> wants to connect" and, accepting,
lands on the scanner; the inviter sees whether they accepted (`connect.answer`). An
invitation connects nobody: the token still does, in person. `connectInvites.js` in the
app, `send_invite` in `backend/app/realtime.py`.

## Operations

All need the access token (the user is its `sub`). `location` is
`{ latitude, longitude, accuracy, timestamp, mocked }` or `null` when the phone has
no position: it is sent already, for the distance check below.

| Operation | Request | Answer |
| --- | --- | --- |
| startSession | `POST /connections/sessions` `{ location }` | `{ sessionId, token, expiresAt }` |
| rotateToken | `POST /connections/sessions/{id}/token` `{ location }` | `{ token, expiresAt }` |
| getSession | `GET /connections/sessions/{id}` | `{ status: waiting \| connected \| closed, user? }` |
| closeSession | `DELETE /connections/sessions/{id}` | 204 |
| claim | `POST /connections/claims` `{ token, location }` | `{ status: 'connected', user }` |

`user` is `{ id, username, name }`: for the host, who scanned; for the guest, whose
code it was. Errors carry `{ code }` in the body, one of `CONNECT_ERRORS` in
`protocol.js`: `expired` (410), `self`, `blocked` (403), `already` (409),
`too_far` (403), `rate_limited` (429).

## What the server must check now

- **Tokens**: random, at least 128 bits, opaque (no user ID or username inside: nobody
  can make a code for someone else), valid 10 s, **single use**. A session hands out a
  new one every 5 s; closing the session invalidates them all.
- **Relations**: not the same user (`self`), not blocked either way (`blocked`, never
  saying which side), not already connected (`already`).
- **Rate limits**: per user, e.g. 10 claims and 10 sessions a minute.
- **One connection, both sides**: create it for both users at once; undo a past
  disconnection between them.

- **Distance**: when both positions are recent (2 min) and real (not `mocked`), they
  must be within 100 m (`MAX_DISTANCE_M`, beyond their accuracy); `too_far` otherwise.

## Planned

- **Device integrity**: an App Attest / Play Integrity assertion
  (`@expo/app-integrity`) on startSession and claim, so scripts and modified apps
  cannot call these operations.

## Why each rule

| Attack | Stopped by |
| --- | --- |
| Making a code for someone else | Tokens are opaque and issued by the server |
| Sending a photo of the code to someone far away | Valid 10 s and single use; screenshots of the code blocked in the app (expo-screen-capture); the distance check when both positions are known |
| Leaving a code valid on a phone in a pocket | The session closes when the screen closes or the app goes to the background |
| Calling the API with a script | Access token, rate limits; later, device integrity |

Positions are used only for this check and must not be stored.
