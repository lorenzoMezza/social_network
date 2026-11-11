# API v1

The contract between the app and the backend: what the production backend must
answer, exactly. The development server in this folder (`backend/app`, FastAPI, in
memory) implements it and is its reference; the rules and threat model of connecting
in person are in `docs/CONNECT-PROTOCOL.md`. Parts marked
**[planned]** are decided but not built yet: [Status](#status) says who does what.

## Principles

In this order: **security, then efficiency, then speed**.

1. **The server decides, the phone shows.** Every rule (who sees whom, who may write,
   who may change what) is checked on the server for every request; the app's copies
   are only the last known state.
2. **Two channels, each for what it does best.**
   - **HTTPS (REST)** for everything stored: profiles, events, chats, photos. Small,
     cacheable (ETag), safe to retry, works with any CDN or load balancer.
   - **One WebSocket** per signed-in app in front (`/v1/ws`) for everything live: the
     people on the map, gestures, words said to everyone around, new messages,
     connections, events changing. Nothing is polled.

   Sending a chat message goes over HTTPS (stored and acknowledged, with or without
   the socket); receiving it comes over the socket. In the background the socket is
   closed and push notifications take over **[planned]**.
3. **Ask once, then only for what changed.** Every GET answer has an ETag (a 304 costs
   no body); media live at immutable URLs; the socket tells what changed; after being
   offline the app asks only for what it missed (`after`, socket resume **[planned]**).
4. **Never one request per item.** Lists carry the people they mention as
   `UserSummary`; one list endpoint per screen.
5. **Send the least personal data that works.** Positions only when needed, rounded
   when exactness is not needed, never stored as history; nothing secret in URLs.

REST (not GraphQL or gRPC) on purpose: plain HTTP caching and CDNs, the simplest
server, and nothing extra in the app.

## Conventions

- Base URL: `https://api.<domain>/v1` (development: `http://<computer>:7777/v1`). No
  sign-in on `GET /health` (`{ ok: true }`), `GET /exports/{token}` and `POST /store/*`.
  Only in the development server: `/storage/{id}` and `/media/{key}` (stand-ins for the
  object storage and the CDN: the app only follows the URLs it is given).
- **Auth**: `Authorization: Bearer <access token>` issued by Logto for the API resource
  (`EXPO_PUBLIC_API_RESOURCE`): a JWT valid about an hour, refreshed by the app with
  its refresh token. The server checks it locally with the cached JWKS
  (`https://bl5ooc.logto.app/oidc/jwks`, fetched again when a `kid` is unknown):
  signature, `iss`, `aud` (always) and `exp`, with a minute of clock leeway; the user is
  the `sub` claim. No request to Logto per API call, no opaque tokens. 401 when the
  token is missing or invalid, 403 when the user may not do what was asked.
  Development only: an app built without `EXPO_PUBLIC_API_RESOURCE` sends an opaque token, which
  the development server checks with Logto's `/oidc/me`; with `API_RESOURCE` set it is refused.
- **Accounts** are made by the user's first request. Their name, @handle and email come
  only from what Logto signed: the app sends its **ID token** in `X-Id-Token` on
  `GET /me`, the server verifies it like an access token (`aud`: the app's client ID,
  the same `sub`) and reads `name`, `username`, `email`. The app
  also sends them as plain JSON in `X-Profile-Hint`, which a client can fake (an email it
  does not own): only a development server looks at it, never in production. An expired ID
  token still names the account of that sign-in; one that does not verify names nothing
  (the account stays unnamed until one does). Names made by the server's rules (Text).
- **Users have public IDs of their own** (`usr_…`, random), never the Logto `sub`: the
  identity provider can change without changing anyone's ID, and its identifiers stay
  private. **[planned]**: today the ID is the `sub`.
- JSON in camelCase, UTF-8. Times are ISO 8601 in UTC with milliseconds
  (`2026-10-15T18:00:00.000Z`). Coordinates in WGS 84 degrees, distances in metres.
- IDs are opaque strings with a type prefix and at least 72 random bits (`ev_`,
  `chat_`, `msg_`, `ph_`, `up_`…; event chats `event:<eventId>`): never parse them,
  never guessable, so an ID alone gives nothing away.
- HTTPS only (TLS 1.2+, 1.3 preferred, HSTS), over **HTTP/2** (one connection for all
  requests: no batching endpoints needed). Responses over 1 KB are compressed (Brotli
  or gzip) when the client accepts it.
- **Which app is asking**: every request carries `X-Client: <app version> (<ios|android>)`;
  an app too old to be served answers `426 upgrade_required`, and the app asks to update
  whatever screen it is on. No header (a store's notice, a data export in a browser) is
  served as ever.
- **Retries are safe**: GET, PUT and DELETE are idempotent. A POST that creates
  something carries `Idempotency-Key: <random>` (kept 24 h): the same key again answers
  the first result instead of creating it twice (an upload, an event, a group, a report,
  a photo, a poll, a rating) **[planned]**; built, and sent by the app, for `POST /events`
  and `POST /events/{id}/photos`. Messages use their `clientId` the same way (built).
- **Lost updates**: a `PATCH` of something several people or devices may edit (an
  event, a group, the profile) may send `If-Match: <ETag>`: `412 precondition_failed`
  when it changed meanwhile (the app reloads it and shows the change) **[planned]**.
- **Errors**: the HTTP status and `{ "code": "...", "message": "..." }`. `message` is
  for developers; the app shows its own text for each `code`. Codes used: `bad_request`,
  `unauthorized`, `forbidden`, `not_found`, `conflict`, `username_taken`, `rate_limited`,
  `too_large`, `invalid_avatar`, `expired`, `self`, `blocked`, `already`, `too_far`,
  `too_close`, `too_many_events`, `full` (409, no spots left), `album_full` (409),
  `photo_limit` (409), `past_event` (409, an event that took place stays where it is), `group_full` (409), `too_many_groups` (409), `too_many_connections` (409),
  `too_many_blocks` (409), `too_many_saved` (409), `too_many_joined` (409), `position_needed` (409),
  `position_rejected` (409), `closed` (409, a poll), `insufficient_balance` (402),
  `price_changed`, `invalid_purchase`, `gone`, `moderated`, `upgrade_required`,
  `precondition_failed`, `internal` (500), `unavailable` (503, with `Retry-After`:
  maintenance). Validation errors may add `details: [string]`. The app also reads the bare
  status for its messages (400, 401, 403, 404, 409, 410, 413, 422, 429), so a status must
  mean what it says here.
- **Lists** that can grow are paginated by cursor: `?cursor=<opaque>&limit=<n>` →
  `{ "items": [...], "nextCursor": "..." | null }`. Lists that are small by nature
  (connections, chats, an event's followers) come whole, still as `{ "items": [...] }`.
- **Text** people write (names, bios, titles, descriptions, messages, polls, comments, words
  to everyone) is kept without control characters and what turns or hides text on screen
  (bidi overrides, zero-width spaces: `\u0000-\u0008 \u000b \u000c \u000e-\u001f
  \u007f-\u009f \u200b \u200e \u200f \u202a-\u202e \u2060 \u2066-\u2069 \ufeff`; the emoji
  joiner `\u200d` stays): a name must not read as someone else's. Lengths count characters, after
  this. Nothing left: as empty. Text fields must be strings: anything else is 400.
- **People** appear everywhere as a `UserSummary`, never as a bare username, so every
  screen can show their picture and open their profile:

```json
UserSummary
{ "id": "usr_3kT9pQ2xA1bZ", "username": "sara_m", "name": "Sara Moretti",
  "pictureUrl": "https://…/sara.jpg" | null, "avatarVersion": 3, "backdrop": "ocean" | null }
```

  `username` is the unique @handle (3–30 of `a-z 0-9 . _`, no leading/trailing or
  double dot); `name` is the display name (1–30). `avatarVersion` changes when they
  save a new avatar (the app reloads it only then). `backdrop`: their profile's
  backdrop (ProfileStyle), whose colour marks them on the map (name and rings).
- **Uploads** never go through the API: the API hands out a signed address, the app
  sends the file straight to the storage, then names the upload in the request that
  uses it (see Uploads).
- Rate limits answer 429 `rate_limited` with `Retry-After` (seconds): the table under **Rate limits**.
- **Caching**: every `200` JSON answer to a GET has an `ETag` and `Cache-Control:
  private, no-cache` (unless the route says otherwise); a GET with `If-None-Match`
  naming the current ETag answers `304` without a body. See Caching below.


### Rate limits

Per person and action, in a sliding window. What a script could abuse is limited, what a person does is never noticed. Other limits (one gesture every 2 s to the same person, a broadcast every 10 s, frames on the socket, an invitation every 10 s to the same person) are with what they limit.

| Action | Times | In | What it covers |
|---|---|---|---|
| `message` | 20 | 10 s | chat messages |
| `direct-chat` | 30 | 3600 s | new direct chats (people nearby) |
| `event` | 20 | 3600 s | events created |
| `upload` | 120 | 3600 s | upload tickets |
| `picture` | 30 | 3600 s | profile and group pictures changed |
| `purchase` | 30 | 3600 s | store purchases sent to be credited |
| `report` | 20 | 3600 s |  |
| `connect-session` | 10 | 60 s |  |
| `connect-claim` | 10 | 60 s |  |
| `gesture` | 60 | 60 s | gestures, whoever to (each brings the sender on a map) |
| `invite` | 30 | 3600 s | "Connect" invitations, whoever to (each is a notification) |
| `save` | 120 | 60 s | events saved and unsaved |
| `chat-edit` | 120 | 3600 s | running a chat: names, roles, mutes, pins, read-only (each one reaches everyone in it) |
| `block` | 60 | 3600 s | people blocked and unblocked |
| `connect-token` | 30 | 60 s | new codes for a session (the app asks for one every 5 s) |
| `requests` | 3000 | 60 s | all requests of one person: nothing a person does comes near it |
| `people` | 600 | 60 s | profiles read: nobody walks through everyone's connections |
| `profile` | 300 | 3600 s | changes to the profile |
| `username` | 5 | 86400 s | another @handle: nobody takes over names by the dozen |
| `export` | 5 | 3600 s | copies of one's data (GDPR art. 15, 20) |
| `vote` | 30 | 60 s | votes in polls |
| `group` | 20 | 3600 s | groups created |
| `members` | 60 | 3600 s | people added to groups |
| `join` | 60 | 60 s | joining and leaving events |
| `rating` | 30 | 3600 s | ratings written |
| `event-edit` | 120 | 3600 s | changes to events |
| `avatar` | 60 | 3600 s | avatars saved (each new look is made by the avatar server) |

## Me

| | | |
|---|---|---|
| `GET /me` | | `Me` (creates the account on the first call) |
| `PATCH /me` | any of `{ name, username, bio, style, settings, story, storyAudience }` | `Me`; 409 `username_taken` (also a handle that would read as the app: `admin`, `support`, `official`…) |
| `PUT /me/story/hidden/{activityId}` | | 204: that moment of the user's story is not shown to others |
| `DELETE /me/story/hidden/{activityId}` | | 204: shown again |
| `DELETE /me/story/hidden` | | 204: every hidden moment shown again |
| `PUT /me/picture` | `{ uploadId }` (purpose `profile-picture`) | `Me` |
| `DELETE /me/picture` | | `Me` |
| `PUT /me/avatar` | `Avatar` (avatar-server/shared/avatarFormat.js) | `AvatarEntry`; 400 `invalid_avatar` with `details` |
| `POST /me/push-tokens` | `{ token ≤ 256, platform: "ios" \| "android" }` | 204. A phone is one person's at a time: a token someone else had moves to this account. At most 10, the oldest goes |
| `DELETE /me/push-tokens/{token}` | | 204: this phone signs out |
| `DELETE /me` | | 204: account and everything that is the user's deleted (GDPR art. 17: profile, picture and every file, avatar, connections, blocks, events they organized with their album and chat, photos and messages they posted anywhere, ratings, follows, uploads, push tokens, the wallet and its credits) and the Logto user. A group they owned passes on (Moderation) and is deleted only if nobody is left in it. Reports about them are kept for safety; reports they filed lose their name (app/privacy.py) |
| `PUT /me/consents/{kind}` | `{ version, mode? }` (kind: `location-sharing`) | 204: a consent the user gave in the app, with the version of the text they read (GDPR art. 7(1)); in the export |
| `POST /me/export` | | `{ url, expiresAt }`: a one-time link to a copy of the user's data (GDPR art. 15, 20), valid 10 minutes; 5 per hour. The app only opens it; what it holds: app/privacy.py |
| `GET /exports/{token}` | (no sign-in: the link is the key) | The copy as a JSON file (`Content-Disposition: attachment`, `no-store`); 410 `expired` once used or late |

```json
Me = UserSummary + {
  "email": "mario@example.com" | null,
  "bio": "≤ 200 chars",
  "style": ProfileStyle,
  "settings": { "notifyEventUpdates": true, "notifyConnections": true, "notifyMessages": true },
  "stats": Stats,
  "story": { "organized": true, "going": true, "reviewed": true, "connected": true },
  "storyAudience": "connections" | "everyone",   // see People; "connections" for a new account
  "storyHidden": 2,
  "unreadNotifications": 3,
  "createdAt": "…"
}
ProfileStyle { "backdrop": "studio|sunset|ocean|forest|candy|lemon|night|ember",
               "pedestal": "none|disc|ring", "effect": "none|sparkles|bubbles|fireflies|notes|hearts|confetti|petals",
               "greeting": "wave|fistpump|handsair|dab|dontsee|punch|shrug", "outline": "outline|none" }
Stats { "organized": 4, "connections": 7 }
```

There is no score yet: the profile's tile says "Coming soon", and ratings earn nobody points.

A new account takes its name and @handle from the Logto profile (username, or the name it
signed in with), made unique with a number when needed (Conventions, Accounts). **Never from the
email**: a public @handle must not tell people an address. With neither: `user` and random digits,
and the app lets them change it.

## People

| | | |
|---|---|---|
| `GET /users/{id}` | | `Profile`; 404 when they blocked the user (whom the user blocked stays visible, `relation.blocked`, to unblock them) |
| `GET /users/{id}/avatar` | | `AvatarEntry` (`ETag`: the version and the map avatar; `If-None-Match` → 304) |
| `GET /users/{id}/events` | | `{ items: [OrganizedEvent] }`, newest first (see below: who may) |
| `GET /users/{id}/activity` | `?cursor&limit=30` | `{ items: [Activity], nextCursor }` |
| `GET /users/{id}/connections` | | `{ items: [{ user: UserSummary, mutual }], total, mutual }`: the ones shared with the user first, then by name; nobody blocked either way (`total: null` when the story is not theirs to see) |

```json
Profile = UserSummary + { "bio", "style": ProfileStyle, "stats": Stats,
  "relation": { "connected": true, "connectedSince": "…" | null, "blocked": false,
                "canMessage": true,          // relation to the user asking
                "seesStory": true } }        // false: see below; `stats` then has null values
AvatarEntry { "userId", "source": "saved" | "preset", "avatar": Avatar, "avatarVersion": 3,
              "mapAvatar": "9e08b7907730a40f634a146086f5c5ae" | null }   // see Avatars
OrganizedEvent { "event": EventSummary, "people": 12, "past": true }
Activity { "id", "kind": "organized|going|went|reviewed|connected", "at": "…",
           "upcoming": false, "event": EventSummary | null, "person": UserSummary | null,
           "rating": { "rating": 8, "comment": "…" } | null,
           "place": "…" | null,   // connected
           "hidden": false }   // one's own story only: not shown to others (the others never get it)
```

Activity is the profile's story: events organized, joined (going, went; joining never says where someone is now),
reviewed, and connections made (only those between the profile and the user asking,
when it is someone else's). Upcoming entries first (soonest first), then the past,
newest first. Its owner chooses what others see: kinds of moments (`Me.story`:
`{ organized, going, reviewed, connected }`, all true by default) and single moments
(by their `id`, the same every time: it is what `/me/story/hidden/{activityId}` keeps);
they always see all of it, the hidden ones marked `hidden`.

**Who may know what someone does** (`Me.storyAudience`, `Store.sees_story`): their
connections (the default), or `everyone`. Someone else gets, from the server:

- `/users/{id}/activity`, `/events`, `/connections` with no items, and `Profile.stats` with
  null values, `relation.seesStory: false`. Name, @handle, picture, bio and avatar stay:
  they appear by them on events, chats and the map.
- not them among an event's `followers` (`followerCount` still counts them), their
  `Rating.user` and `Photo.author` null (the rating and the photo still show and count), not
  named in `album.photos` notifications, and not them among the members
  of an event's chat, unless the one asking runs it (the organizer sees who comes, and
  the admins of its chat, to moderate).

What they write in a chat or post in an album shows with their name: that they choose to say.

## Connections, blocks, reports

A connection is a friendship made only in person (`POST /connections/claims`, below). At most 5000
per person (409 `too_many_connections`).

| | | |
|---|---|---|
| `GET /me/connections` | | `{ items: [Connection] }`, newest first |
| `DELETE /me/connections/{userId}` | | 204. Disconnect: no messages until they connect again in person; they are not told |
| `GET /me/blocks` | | `{ items: [{ user: UserSummary, since }] }` |
| `PUT /me/blocks/{userId}` | | 204. Ends the connection; hides each from the other everywhere; each leaves the groups the other owns, the events the other organizes (a block must not make someone invisible to who runs where they write). At most 5000 (409 `too_many_blocks`) |
| `DELETE /me/blocks/{userId}` | | 204. Does not reconnect |
| `POST /reports` | `Report` | 201 `{ id }` |

```json
Connection { "user": UserSummary, "since": "…", "place": "Thursday running club" | null }
Report { "kind": "user|event|photo|message|group", "targetId": "…", "eventId": "…" (photos),
         "reasons": ["harassment"], "details": "≤ 500" }
```

Report reasons: users `harassment hate threat sexual impersonation spam minor other`;
events `offensive content`, `inappropriate content`, `not an event`; photos
`shows_me inappropriate harassment unrelated`; messages and groups `harassment hate threat
sexual spam other`. 404 for what does not exist or the user could not have seen (a message of a
chat they are not in). The server keeps a copy of what was reported as it was at that moment
(the text of a message, a picture's address): it may change or go before anyone reads it.

### Connecting in person (CONNECT-PROTOCOL.md)

| | | |
|---|---|---|
| `POST /connections/sessions` | `{ location }` | `{ sessionId, token, expiresAt }` |
| `POST /connections/sessions/{id}/token` | `{ location }` | `{ token, expiresAt }` (a new token every 5 s) |
| `GET /connections/sessions/{id}` | | `{ status: "waiting" \| "connected" \| "closed", user?: UserSummary }` |
| `DELETE /connections/sessions/{id}` | | 204 |
| `POST /connections/claims` | `{ token, location }` | `{ status: "connected", user: UserSummary }` |

`location`: `{ latitude, longitude, accuracy, timestamp (ms), mocked } | null`. Older than 2 minutes it
counts as missing: the server then uses where the map last saw the user, if anywhere. `mocked: true` is refused.

Tokens: ≥128 random bits, opaque, 22 to 128 characters of `A-Z a-z 0-9 _ -` (base64url without
padding: the app reads only such a code), valid 10 s, single use. Errors `expired` 410, `self`
403, `blocked` 403, `already` 409, `too_far` 403 (a mocked or impossible position; or
both known, from the request or else the map, and over 100 m apart beyond their accuracy,
counted up to 100 m each; a phone with no position at all is not stopped),
`rate_limited` 429 (10/min). The host hears the scan at once over
the socket (`connection.created`); `GET` of the session is only a fallback.

## Chats

Three kinds: `direct` (with a connection, or someone nearby right now not
disconnected from), `group` (owned by its creator, who adds only their own
connections; at most **256 people**, 409 `group_full`, and one person owns at most **50**, 409
`too_many_groups`; it shows what was said **since someone joined it**, also when they come
back), `event` (id `event:<eventId>`: the organizer and everyone who joined
the event, from its creation until it ends; its whole history is for who joins).

| | | |
|---|---|---|
| `GET /chats` | | `{ items: [ChatSummary] }`, newest message first, the newest 500 (an older chat comes back with its next message) |
| `POST /chats/direct` | `{ userId }` | `ChatSummary` (the existing one, or 201 new); 403 when not allowed. Until someone writes in it, it shows only to who opened it |
| `POST /chats` | `{ title, color, memberIds }` | 201 `Chat` (a group) |
| `GET /chats/{id}` | | `Chat` |
| `PATCH /chats/{id}` | `{ title?, color?, readOnly? }` | `Chat` (owner, admin; event chats: `readOnly` only) |
| `POST /chats/{id}/members` | `{ userIds }` | `Chat` (groups: owner, admin; their own connections only, and nobody with a block with the owner) |
| `DELETE /chats/{id}/members/{userId}` | | 204: `me` leaves, or a higher role removes someone (Moderation) |
| `PUT /chats/{id}/members/{userId}/role` | `{ role: "admin" \| "member" }` | `Chat` (owner) |
| `PUT /chats/{id}/members/{userId}/mute` | `{ minutes: 60 \| 480 \| 10080 \| null }` | `Chat` (a higher role; `null`: until unmuted) |
| `DELETE /chats/{id}/members/{userId}/mute` | | `Chat` (a higher role) |
| `PUT /chats/{id}/picture` | `{ uploadId }` (purpose `group-picture`, `chatId`) | `Chat` (groups: owner, admin; said in the chat) |
| `DELETE /chats/{id}/picture` | | `Chat` (owner, admin) |
| `DELETE /chats/{id}` | | 204: the owner deletes their group for everyone |
| `PUT /chats/{id}/pins/{messageId}` | | `Chat` (owner, admin; at most 3: a fourth unpins the oldest) |
| `DELETE /chats/{id}/pins/{messageId}` | | `Chat` (owner, admin) |
| `POST /chats/{id}/polls` | `{ question: 1–200, options: [2–10 × 1–80, all different], multiple: false }` | 201 `Message` with its `poll` (owner, admin) |
| `POST /chats/{id}/polls/{messageId}/votes` | `{ optionIds: [] }` | `Message` (any member not muted; replaces their vote, `[]` takes it back; 409 once closed) |
| `POST /chats/{id}/polls/{messageId}/close` | | `Message` (its author, the owner, an admin) |
| `GET /chats/{id}/messages` | `?before=<messageId>&limit=50` | `{ items: [Message] (old → new), nextCursor }` (older page; `nextCursor` is a message ID the app may keep and send days later; unknown: the newest page). Pages hold only what the user may see |
| `GET /chats/{id}/messages` | `?after=<messageId>&limit=100` | `{ items: [Message] (old → new), nextCursor }`: the messages after one the app has (it was offline), `nextCursor` the `after` for the next ones while there are more; 404 for an unknown message, 400 with `before` too |
| `POST /chats/{id}/messages` | `{ text, clientId ≤ 64 }` | 201 `Message`. The same `clientId` again within a day → the same message, **before any other rule**: it was allowed when it was written, whatever changed since |
| `DELETE /chats/{id}/messages/{messageId}` | | `Message`, removed: by its author, or a higher role than theirs. Its text goes for everyone and from the server; its place stays (`deleted`), and everyone gets `message.updated`. System messages stay; direct chats: only the author |
| `POST /chats/{id}/read` | `{ messageId }` | 204. Never goes back; the user's devices hear `chat.read` |

```json
ChatSummary { "id", "kind", "title", "color": "#1F9D63" | null,
  "pictureUrl": "https://…" | null,      // a group's (512 px square); null: its colour
  "with": UserSummary | null,            // direct
  "event": { "id", "title", "categories", "theme" } | null,   // event
  "memberCount": 5, "ownerId": "…" | null, "lastMessage": Message | null,
  "lastAuthor": UserSummary | null,      // who wrote it (the inbox shows their name)
  "unread": 2, "readAt": "…", "canWrite": true,
  "why": null | "nearby" | "away" | "disconnected"    // direct: why one can (not) write
       | "muted" | "readonly",           // groups, event chats
  "closesAt": "…" | null,                // event: when the event ends
  "role": "owner" | "admin" | "member" | null,   // the user's (null: direct)
  "readOnly": false, "muted": false, "mutedUntil": "…" | null,   // null while muted: until unmuted
  "pinned": [Message] }                  // newest pin first, at most 3
Chat = ChatSummary + { "members": [{ "user": UserSummary, "role": "owner" | "admin" | "member",
                                     "muted": false, "mutedUntil": "…" | null }] }
                                     // owner first, then admins, then the user; at most 200 (memberCount: all);
                                     // muted: told to the owner and admins only
Message { "id", "chatId", "from": "<userId>", "text": "≤ 1000", "at": "…",
          "clientId": "…" | null, "system": false, "deleted": false, "poll": Poll | null }
Poll { "question", "options": [{ "id": "o1", "text", "votes": 2 }],
       "multiple": false, "closed": false, "voterCount": 3, "creator": "<userId>",
       "mine": ["o1"] }   // answers to one person only: what goes to the whole chat has no
                          // `mine`, and the app keeps what it knew. A message's size never
                          // grows with its chat
```

### Moderation

Groups and event chats have an **owner** (the group's creator, the event's organizer),
**admins** named by the owner, and **members**. The server checks every rule:

- The owner names and removes admins, and acts on everyone but themselves.
- Admins rename the group, add their own connections, remove and mute members, make
  the chat read-only, pin messages, start polls, choose the group's picture and remove
  members' messages. They act on members only, never on another admin or the owner. Only the
  owner deletes the group for everyone.
- Removing and muting need a higher role than the person's: 403 otherwise (404 for
  who is not in the chat, nothing at all in direct chats).
- Everyone may leave (`DELETE …/members/me`). **A group's owner too: it passes** to the
  admin who has been in it longest, else to whoever has been in it longest, who is told
  with a system message; whoever has a block with the new owner leaves with it (`chat.removed`).
  With nobody left, the group ends. Deleting the account does the same. An event's organizer
  does not leave its chat: they cancel the event.
- **Event chats**: leaving the chat leaves the event (the user may join it again).
  Removed from the chat by a higher role: out of the event for good
  (`PUT /events/{id}/followers/me` → 403).
- **Read-only**: only the owner and admins write; members still vote in polls.
- **Muted**: no messages and no votes until `mutedUntil` (or until unmuted). Making
  someone an admin unmutes them.
- Admin changes and read-only changes are told in the chat as system messages, and in a group
  also leaving and removals. **In an event's chat nobody is named for leaving or being removed**:
  it would tell everyone who was going, also about someone who keeps that to their connections.
  A role or a mute does not survive leaving. Joining an event's chat, what was said so far is there
  to read but not counted as new.

## Events

| | | |
|---|---|---|
| `GET /events` | `?latitude&longitude&range=2000&categories=a&categories=b` | `{ items: [EventSummary] }` |
| `GET /me/events` | | `{ followed: [EventSummary], created: [EventSummary] }`: `followed` is the Saved list (saved or joined; not one's own), `created` the user's own: what took place stays in them, and only an event cancelled before it began can be removed; each list its latest 500 |
| `GET /events/{id}` | | `Event` |
| `POST /events` | `EventInput` (`Idempotency-Key`: the same event again, never a second one) | 201 `Event`; 409 `too_close`, `too_many_events` (Room and limits below) |
| `PATCH /events/{id}` | part of `EventInput`, and `images` | `Event` (organizer); 409 as `POST`; 410 `gone` once cancelled or over, its theme too; a refused change changes nothing |
| `DELETE /events/{id}` | | `Event`, cancelled (organizer); its followers are told |
| `PUT /events/{id}/followers/me` | | `{ following: true, followerCount }`: joined (going; on its people, chat and album; its organizer is told); at most 200 not over yet at a time (409 `too_many_joined`) |
| `DELETE /events/{id}/followers/me` | | `{ following: false, followerCount }`: not going any more; once the event took place 409 `past_event` |
| `PUT /events/{id}/saved/me` | | `{ saved: true }`: a private bookmark (nobody is told); at most 1000 that can still happen (409 `too_many_saved`); not once it took place (409 `past_event`) |
| `DELETE /events/{id}/saved/me` | | `{ saved: false }`. An event that took place (it ended, or was cancelled once it began) cannot be taken out of the lists: 409 `past_event`. One cancelled before it began also leaves the Saved list and the organizer's `created` |
| `DELETE /me/saved/cancelled` | | 204: every event cancelled before it began out of the Saved list |
| `POST /events/{id}/ratings` | `{ rating: 0–10, comment }` | 201 `Rating`; 409 when already rated; 403 before it starts, for the organizer and for who did not join it |
| `PUT /events/{id}/ratings/me` | `{ rating, comment }` | `Rating` |
| `DELETE /events/{id}/ratings/me` | | 204 |

`GET /events` takes a point **rounded to about 110 m** (3 decimals of a degree, in the
app): enough to find what is around, not the user's exact place, and the same point
for everyone nearby, so answers repeat and cost a 304. The app asks when it opens or
comes back to the front and after moving about 500 m from the last point; in between
new and changed events arrive over the socket (`event`), with no polling.

**Pictures** (`images`): the whole list, in order, at most 6; the first is the cover
(`imageUrls[0]`). Each one is `{ url }` (one of the event's current `imageUrls`, kept) or
`{ uploadId }` (a new upload, purpose `event-cover`, for this event). Everything is
checked before any upload is used, so a bad item changes nothing; pictures left out are
deleted. `[]`: no pictures (the page shows no banner).

`GET /events` answers the events within `range` of the point (max 10 km) **and within
their own reach** (`reach`: 100–800 m, or a promotion's radius while it is paid; see
Promotions), not cancelled and not ended more than a day ago, nearest first, at most
200. The `event` frames of the socket follow the same reach; an event whose reach
shrank is sent once more to who saw it from farther, so the app drops it.

```json
EventInput { "title": "1–50", "description": "1–500", "categories": ["music"],
  "location": { "latitude", "longitude", "address": "≤ 200" | null },
  "dates": { "startDate", "endDate" }, "links": "https://…" | null,
  "flash": false, "spotsNeeded": 0, "theme": EventTheme | null,
  "reach": 800 }                          // metres, 100–800 (ignored for flash: always 800)
EventTheme { "color": "#hex" | null,                    // its page and its tile in lists
             "beam": "#hex" | null,                     // its light on the map
             "beamStyle": "beam|pulse|helix|stardust|veil",   // how that light looks
             "emoji": "🎉" | null,                      // a symbol: no letters or digits
             "background": "plain|glow|tint|aurora|pattern", "title": "classic|bold|serif|mono" }
EventSummary { "id", "title", "description", "categories", "location",
  "dates": { "creationDate", "startDate", "endDate", "modifiedDate"?, "cancelDate"? },
  "status": "upcoming|ongoing|concluded|cancelled", "flash", "spotsNeeded", "theme",
  "imageUrls": ["cover"], "links", "creator": UserSummary,
  "followerCount": 12, "photoCount": 3, "following": true,
  "saved": false,                         // the user's private bookmark (`following`: joined, going)
  "friendsGoing": 2, "friends": [UserSummary],   // the user's connections going: how many, the first 3
  "reach": 800,                           // how far away people see it now (metres)
  "sponsored": false }                    // a promotion pays for its reach now
Event = EventSummary + {
  "followers": [UserSummary],            // who is going: the user, their connections, the others (at most 200: followerCount is the total)
  "ratings": [Rating], "myRating": Rating | null,   // the newest 100; the user's own always in myRating
  "ratingCount": 140, "ratingAverage": 7.4 | null, // over all the ratings (0–10), not only the 100 listed
  "album": AlbumSettings,
  "baseReach": 800, "promotion": Promotion | null }   // the organizer's only
Rating { "id", "user": UserSummary, "rating": 8, "comment": "≤ 500", "date", "modifiedDate"? }
```

Categories: `sales social free entry food drinks relaxing sports exposition games music
shopping clothes technology festival festivities party competitive convention`.
`flash` events start within the hour and last 1–3 h; `spotsNeeded` 0–20 (0: anyone): that many
people can join (the organizer not counted), then 409 `full` (the app shows how many are left).
A flash event stays one, and a normal event normal: `flash` counts only when creating.
An event lasts at most 31 days and is written in the future: new dates cannot start in the past
nor end by now (400). **Once started, its start stays**, and it ends at most **62 days after it
was made**: moved on again and again it would stay on the map for good (400). Once over it can no
longer be joined nor changed (410 `gone`).
A flash event is made only within 500 m of its organizer (a plan for right around
them): the server checks it against their presence (their phone's GPS, sent on the
socket). Invisible, the server keeps no position: the app then sends it with the
request, `"from": { latitude, longitude }`, used for that check only and not stored.
409 `too_far` farther, 409 `position_needed` when neither is there. The app also refuses
a farther long press on the map at once.

**Theme** (`EventInput.theme`). `null` is no theme. Every write replaces all of it: a field
left out or null goes back to its default (`color`, `beam`, `emoji` null, `beamStyle` beam,
`background` plain, `title` classic), an answer always has all six and unknown fields are
dropped. `color` and `beam` are checked as `#RRGGBB` and kept exactly as sent, case too: the
app offers fixed lists and treats any other value as not chosen. On the map gold means
`sponsored` and nothing else: a sponsored event is gold whatever `beam` says (keeping its
`beamStyle`), and its `beam` comes back when the promotion ends. That is the app's rule, the
server stores `beam` as usual. A change of the theme alone sends the `event` frame and sets
`modifiedDate`, but tells nobody (`event.changed` is for a new time or place). Flash events
have a theme too.

**Room and limits**, checked by `POST` and by a `PATCH` that moves the event or its dates
(the app checks first with the events it knows, the server decides):

- **A month ahead at most**: an event starts within **31 days** of now, when it is
  created or its start is moved (a start it already has stays). 400 otherwise.
- **Room**: no event within **15 m** of another (anyone's) that is not over. The map
  shows every event from the moment it is made until it ends, whenever it starts, so
  two events that close would be drawn on top of each other; cancelled and ended
  events take no room. 409 `too_close`.
- **Events on at once**: an organizer has at most **5** events not ended and not
  cancelled (upcoming or ongoing, flash included). 409 `too_many_events`; cancelling
  one, or one ending, makes room.

### Albums

| | | |
|---|---|---|
| `GET /events/{id}/photos` | `?cursor&limit=60` | `{ settings: AlbumSettings, items: [Photo], total, room, nextCursor }`, newest first; `room`: how many more the user may add here |
| `PUT /events/{id}/photos/settings` | `AlbumSettings` | `AlbumSettings` (organizer) |
| `POST /events/{id}/photos` | `{ uploadId }` (purpose `event-photo`; `Idempotency-Key`: the same photo again, never a second one) | 201 `Photo`; 409 `album_full`, `photo_limit`; 410 `expired` for an upload already used (see Uploads) |
| `DELETE /events/{id}/photos/{photoId}` | | 204 (author or organizer) |

```json
AlbumSettings { "whoCanPost": "everyone|chosen|organizer",
                "contributors": ["<userId>"] }   // to the organizer, all of them; to anyone else
                                                 // only themselves if chosen: the names would say who is going
Photo { "id", "eventId", "url" (≤ 2048 px), "thumbUrl" (400 px square), "width", "height",
        "author": UserSummary | null,   // null to who may not know its author went (Who may know what someone does); never to its author or the organizer
        "createdAt" }
```

The album opens when the event starts and never closes; cancelled events have none.
Who adds photos (`whoCanPost`, set by the organizer only): `everyone` (the organizer
and everyone who joined the event, the default), `chosen` (the organizer and the
`contributors`, picked among who joined it) or `organizer`. The organizer removes any
photo, an author their own. Changing the rule never removes photos already added.

**How many**: an album holds at most **500** photos (409 `album_full`). One person adds at most **30**
to an album (the organizer **200** to their own), **100 a day** and **2000 kept in all**, across
albums (409 `photo_limit`). Refused when the upload is asked for, before any file is sent, and again
when it is used; a photo removed makes room. A photo stays as long as its event.
Everything else answers 403 `forbidden`. Later: telling the organizer the day after
to share the photos, approval before showing if abuse appears.

## Uploads

| | | |
|---|---|---|
| `POST /uploads` | `{ purpose, mimeType, fileSize, eventId?, chatId?, width?, height? }` | `{ uploadId, uploadUrl, headers, expiresAt }` |
| `PUT <uploadUrl>` | the file, `Content-Type: mimeType` | 200 (the storage) |

`purpose`: `profile-picture`, `event-cover` (organizer, `eventId`), `event-photo`
(who may post, `eventId`), `group-picture` (owner or admin, `chatId`). JPEG, PNG, HEIC or WebP, at
most 20 MB (`too_large` 413), and only what the file really is counts, not what the client says: any
other format is refused (`moderated` 422). `fileSize` is the file's exact size. A ticket lasts **15
minutes**, a file sent and not used **1 hour**, and one person has at most **20** waiting at a time
(429 with `Retry-After`).
The upload is checked **in the request that uses it**, whose answer already carries the
final URLs (`Me.pictureUrl`, `Event.imageUrls`, `Photo.url`), or refuses it: no job for
later. A file bigger than announced (over 110%) is refused too. An upload is for the purpose, event
or chat it was asked for, once: named again after it was used (or after its hour), the answer is
410 `expired`. A photo whose answer was lost is sent again by the app with the **same `uploadId`
and the same `Idempotency-Key`**, without sending the file a second time: the answer is the photo
already added; from a server that does not keep the key it is that 410, which the app takes as
"it was added" and reads the album again. An upload is used, and its original deleted, when the
request that names it **answers** (the result, or a refusal of the file: 422, 413); a request
that fails for a reason of the server's (5xx, the image service busy) leaves it as it was, so the
same upload can be named again within its hour. The server verifies it is an image, applies the EXIF rotation and **strips all metadata (EXIF with the GPS position first, XMP, comments)**, makes the
sizes (pictures 512 px square, group pictures 512 px square, covers 2048 px, photos 2048 px and a 400 px
thumbnail), deletes the original at once, and may refuse it (`moderated` 422).

## WebSocket `/v1/ws`

One connection while the app is in front and signed in (`wss://`; permessage-deflate is
the server's choice when the socket opens, and the app works with or without it). The client authenticates with its first frame, within 5 s; the server closes
with code 4001 when it does not, or when the token is invalid or expires (the app
reconnects with a fresh one), and pings every 25 s. Tokens never go in the URL. **Text
frames only**, JSON: React Native hands binary frames over as blobs. A binary frame from a
client is an invalid frame (before `auth`: 4001; after: `error` `bad_request`). At most 5 sockets per
user (a sixth closes the oldest, 1008). Other closes: 1008 too many frames; 1013 a phone
that does not read (500 frames waiting): it reconnects and gets a new snapshot. The app
pings every 25 s and reconnects after 40 s of silence, so the server answers `pong`.

```json
→ { "type": "auth", "token": "<access token>" }
← { "type": "ready", "userId": "…" }
                                   // [planned] → "resume": 1042, ← "seq", "resumed", "serverTime"
```

**Resuming** **[planned]** (`resume`, `seq`, `resumed`, `serverTime`). Every frame
about stored state (`message`, `message.updated`, `chat`, `chat.removed`,
`connection.created`, `event`) carries `seq`, a number growing per user. The app keeps
the last one it handled and sends it as `resume` when it reconnects: the server replays
what it missed (it keeps the last 10 minutes or 500 frames per user) and answers
`resumed: true`, so nothing has to be loaded again. When it cannot (too long ago) it
answers `resumed: false` and the app reloads its lists, as it does at every
reconnection today (3 to 6 requests). Presence is never replayed: a new
`presence.snapshot` comes. `serverTime` lets the app correct its clock for countdowns
(mutes, event start).

**Refreshing the token** **[planned]**: shortly before the access token expires the
app sends `{ "type": "auth", "token": "<new token>" }` on the open socket (answered
with `ack`), instead of being closed with 4001 and reconnecting.

Client → server (an optional `ref` is echoed in the answer `{ type: "ack", ref, … }`
or `{ type: "error", ref, code, message }`; `presence` has no ack, only its error):

| type | fields | |
|---|---|---|
| `presence` | `mode`, `position: { latitude, longitude, accuracy, heading, speed, moving } \| null`; `heading` 0–360, `speed` 0–150, `accuracy` ≥ 0: any other value counts as not said, since these go to other people's phones | On change (moved 2 m, turned, started or stopped walking; ≤ 1/s), and every 15 s while the map is on screen and for one minute after the user leaves it for another page of the app. Then `position: null`, once: the server forgets the position and sends no more people, until the map opens again. Invisible: sent once, the same. The socket ending (the app in the background or closed) ends it at once, nothing to send. Without an update for 45 s (a connection lost without a word) the user leaves everyone's map. `error` 409 `position_rejected` when no plane could have got there (Security, Locations): nothing changes |
| `gesture` | `to`, `gesture: wave\|handsair\|fistpump\|dab` | To someone within 1 km (Presence rules), on their map or not; ≤ 1 per 2 s per pair, 60 per minute per person. The map plays a gesture only on someone it shows, so the user enters their map for a minute, before the gesture arrives (never over a connection of theirs) |
| `broadcast` | `text` (1–120) | To everyone who has the user on their map now; ≤ 1 per 10 s; ack `{ recipients }` |
| `connect.invite` | `to` | "Connect" on someone within 1 km (not blocked, not connected; ≤ 1 per 10 s per pair, 30 per hour per person). The one who invites shows My code, the other scans it. Ack `{ invite }`. Errors `forbidden`, `already`, `not_found`, `rate_limited` |
| `connect.answer` | `invite`, `accept` | The invited person's answer, once, within a minute (`expired` after, or when a block came meanwhile) |
| `ping` | | ← `pong` |

Server → client:

| type | fields | |
|---|---|---|
| `presence.snapshot` | `people: [Presence]` | After the first `presence` and every change of mode |
| `presence.delta` | `people: [Presence]`, `removed: [userId]`, `audience?: 12` | Who appeared, moved or changed, batched ≤ 2 per second; someone whose shown position did not change (a keepalive) is not sent. `audience`, when it changed: how many people have the user on their map (what the app shows, and `broadcast` reaches): in a crowd it differs from who the user sees |
| `gesture` | `id, from, gesture, at` | |
| `broadcast` | `id, from, text, at` | |
| `message` | `message: Message`, `author: UserSummary` | A new message in a chat of the user (also their own, from another device) |
| `message.updated` | `message: Message` | A message changed: a poll's votes or closed (without `mine`), or removed (`deleted`, no text). Coalesced on big chats: the last state counts |
| `chat` | `chat: ChatSummary` | A chat appeared or changed (created, renamed, members, the user added) |
| `chat.removed` | `chatId` | Deleted, the user left or was removed, or its event ended |
| `chat.read` | `chatId`, `unread` | The user read it on one of their devices: the others stop counting it as new |
| `connection.removed` | `userId` | The connection with them ended (either of the two, or a block) |
| `events.stale` | | The events the user sees changed (someone blocked or unblocked, an organizer's account gone): the app asks for its lists again |
| `connection.created` | `connection: Connection` | Someone scanned the user's code (or the user scanned theirs) |
| `connect.invite` | `id, from: UserSummary, expiresAt` | Someone nearby wants to connect: accepting opens the scanner, for their code |
| `connect.answer` | `invite, accept, by: UserSummary` | The answer to the user's invitation |
| `event` | `event: EventSummary` | An event was created, edited or cancelled, **made for each person** (`following`, `saved`, `friends`…: the app replaces its copy with it): sent to its organizer, to who joined or saved it, and to everyone online whose events (the centre and range of their last `GET /events`, else 2 km around their map position) include its place, unless blocked either way. A cancelled one carries its status: take it off the map |

```json
Presence { "userId", "user": UserSummary (the first time a person appears on a
  connection, and again whenever it changed: a new name or picture), "avatarVersion",
  "position": { "latitude", "longitude" } (6 decimals), "precision": "precise" | "area",
  "heading": 90 | null, "speed": 1.3 | null, "moving": true | null, "updatedAt": "…" }
```

### Presence rules (who sees whom)

- Both modes count, the less precise wins: visible + visible → `precise`; any
  `approximate` → `area`; any `invisible` → not sent at all.
- `area`: never the real coordinates, no heading, speed or moving. The real position is
  known only to a 300 m square of a grid; the point shown is near its centre, moved by
  an amount derived from a server secret, the same for that person, square and day
  (within ~300 m of the real place). Watching it and averaging gives the square, not the
  place; it changes only when they walk into another square. Whether someone shown by
  area is within range is decided from that point, so the edge of the range cannot be
  used to trilaterate the real place.
- At most **25 people** within 1 km: the user's connections first, then who just waved at them,
  then the nearest; someone already shown keeps their place over someone just a little closer, so the map does not
  flicker (measured: `make map-bench-people`). Blocked people (either way) never. Writing to,
  waving at or inviting someone needs only being within 1 km, shown or not.
- Positions are never stored as history: only the latest, in memory.

### What links open

The app gives out no links of its own, so an outside link (another app, a web page) opens it on its
first page and nothing else: every other screen is one tap from doing something. Only the sign-in callback is
handled, by Logto.

## Avatars

The catalog and the item files are static (`GET <assets>/v1/catalog`, `<assets>/v1/files/…`,
a CDN in production; `avatar-server/` in development). The documents users save are the
API's: `GET /users/{id}/avatar`, `PUT /me/avatar`, validated against the catalog with
`avatar-server/shared/avatarFormat.js` rules. A user who never saved one gets a preset
chosen from their ID.

The app keeps the asset files it downloaded on the device (250 MB, least recently used
first; the user's own avatar always, their connections' map avatars after everyone
else's), so the assets host must answer cross-origin
requests from the app's pages with `Access-Control-Allow-Origin: *`, expose `ETag`
(`Access-Control-Expose-Headers`) and accept `If-None-Match`: a stored file is then
checked with a 304 instead of downloaded again. Whether someone's avatar changed is
`avatarVersion` (and the `ETag` of `GET /users/{id}/avatar`), never the files: a new
look wears other items, that is other files.

**Map avatars.** On the map, other people wear their *map avatar*: the same avatar made
once on the server into one mesh, one skeleton and one texture atlas
(`asset-pipeline/src/mapAvatar.mjs`), so the map draws everyone in a few draw calls.
`AvatarEntry.mapAvatar` is its key; the files are static and never change:
`<assets>/v1/map-avatars/<key>.glb` (geometry, skeleton, material table), `.ktx2` (ASTC
6×6 atlas, 768 px, 4 levels) and `.png` (384 px atlas, GPUs without ASTC). The key is a
hash of the look, so the same look is made once for everyone. The backend asks for it
when the avatar is saved or first read (`POST <baker>/v1/map-avatars`, internal:
`AVATAR_BAKER_URL`, `AVATAR_BAKE_SECRET`); `null` when it could not be made now (the
app shows the stand-in, `GET <assets>/v1/map-avatars/stand-in` → `{ key }`, and the
next read tries again).

## Caching

The app keeps on the phone what it showed, so it opens at once and works without a
connection (`webview/shared/cacheBudgets.js`, about 1 GB at most): map tiles 40 MB;
people 350 MB (avatar files 250 MB, profiles, avatar documents and pictures 100 MB);
events 350 MB (lists, pages, pictures; not albums); chats 250 MB (inbox, messages,
polls, members). In each, what matters least goes first: the user's own data last,
then their connections' (people) or saved events (events), then what was seen
recently. Signing out deletes everything of the account. What it shows from there is
the last known state, never a decision: every answer is checked again with the server
as soon as it can be, and the server's rules always apply (who may be messaged).

So that the copies stay right, the backend:

- gives every GET answer an `ETag` and answers `If-None-Match` with `304` (a hash of
  the body is enough; avatars use their own: version and map avatar);
- serves media at immutable URLs (a new picture gets a new URL) with
  `Cache-Control: public, max-age=31536000, immutable`: a copy of a URL is never out
  of date, and nothing needs checking;
- puts `avatarVersion` in every `UserSummary` and every `Presence`: the app reloads an
  avatar only when it changed, and at once when it does (someone on the map changing
  their look);
- sends a `Presence`'s `user` again when the person's summary changed, so a new name
  or picture reaches everyone around;
- answers `GET /chats/{id}/messages?after=` so a chat the app kept is completed
  exactly after being offline (no hole, no message twice), and accepts the same
  message twice (`clientId`): messages written offline are sent when the connection is
  back.

## Notifications

Only what matters to the user, never noise (the reasons in app/notifications.py):

| kind | to | when |
|---|---|---|
| `event.joined` | the organizer | people joined their event (gathered) |
| `event.rated` | the organizer | people rated their event (gathered) |
| `album.photos` | who went and the organizer | new photos in its album (gathered) |
| `event.changed` | who is going | its time or place changed (`data.changes`: `time`, `place`) |
| `event.cancelled` | who is going | it was cancelled, or its organizer deleted their account (then `event` is null and `data.title` says which) |
| `event.starting` | who is going | it starts within the hour (once; again when it moves to another time) |
| `event.removed` | who was removed | the organizer or an admin took them out of the event, for good |
| `promotion.paused` | the organizer | their promotion could not pay the day |
| `connect.invite` | the person invited | someone near wanted to connect |

Alike unread ones within a day are gathered into one (newest person first, `count`).
Event kinds follow `settings.notifyEventUpdates`, `connect.invite`
`settings.notifyConnections`; `promotion.paused` always comes. Nothing about someone
blocked either way; a saved event (a bookmark) is private and tells nobody. Kept 60
days, the newest 100.

| | | |
|---|---|---|
| `GET /me/notifications` | | `{ items: [Notification], unread }`, newest first (50) |
| `POST /me/notifications/read` | | `{ unread: 0 }` |

Socket: `notification` `{ notification: Notification, unread }` (new or gathered).
`Me.unreadNotifications`: the count at sign-in.

```json
Notification { "id", "kind", "at", "read": false, "actors": [UserSummary], "count": 3,
  "event": EventSummary | null, "data": {} }
```

## Promotions

An organizer shows a normal event (not a flash one) farther than its reach, up to
10 km, paying 24 hours at a time from a wallet of credits (1 credit = €0.01) topped up
with in-app purchases. The rules, prices and reasons: PROMOTIONS.md.

| | | |
|---|---|---|
| `GET /promotions/prices` | | `Prices` |
| `GET /events/{id}/promotion/quote` | `?radius` | `Quote` (organizer) |
| `PUT /events/{id}/promotion` | `{ radius, daily }` | `Event`; 402 `insufficient_balance`, 409 `price_changed`, 403 flash, 410 over |
| `DELETE /events/{id}/promotion` | | `Event`: nothing more charged; it stays promoted until the time paid runs out (status `stopped`, then `ended`). Nothing comes back |
| `GET /me/wallet` | | `Wallet` |
| `POST /me/wallet/purchases` | `{ platform: ios\|android, productId, purchaseToken }` | `{ credited, ...Wallet }`; 400 `invalid_purchase`, 409 `already` (another account's), 503 `unavailable` (store not set up) |
| `POST /store/apple/notifications` | App Store Server Notifications V2 | 200 (server to server: refunds) |
| `POST /store/google/notifications?secret=` | Pub/Sub push of Play RTDN | 204 (server to server: refunds) |

- `PUT` starts, resumes or changes a promotion. **What it buys is time**: 24 hours are
  charged now, the next 24 when those run out, the last stretch only up to the event's end.
  A period the wallet cannot pay pauses it (the event keeps its free reach) until a
  top-up, which resumes it at once for 24 hours from then. With time still paid, a wider
  radius costs the difference for the time left; a narrower one costs nothing and is
  cheaper from the next charge. `daily` is the price the app showed: another price answers
  409 `price_changed` (`details[0]`: the price); 402 `insufficient_balance`: `details[0]`
  is what was due.
- **What comes back.** `DELETE /events/{id}` by the organizer gives back the time paid and not
  used, in credits, at once (a wallet entry of kind `refund`), except the first
  `minHours` of the promotion, which are always paid. A `PATCH` that ends the event
  before the time paid gives back what falls past the new end. Stopping gives nothing back
  (the time paid is still being shown); stopped and then cancelled, the rest still comes
  back. Taken down by moderation, nothing comes back. Credits, never money.
- `daily` is fixed when it starts, with the discount of its days from then to the event's
  end, and only rises if the event gets shorter (from the next charge).
- `purchaseToken`: the StoreKit 2 signed transaction (iOS) or the Play purchase token
  (Android), checked with the store; each transaction is credited once, only to the
  account whose `accountToken` the purchase carries (`appAccountToken` /
  `obfuscatedAccountId`). The app finishes (consumes) the purchase after this answers.
  Development servers (`DEV_TOOLS=1`) also take `platform: "dev"` test top-ups.

```json
Prices { "currency": "EUR", "reach": { "min": 100, "max": 800, "step": 50, "default": 800 },
  "tiers": [{ "radius": 1000, "daily": 99 }, …, { "radius": 10000, "daily": 1299 }],
  "durationDiscounts": [{ "fromDays": 2, "percent": 10 }, …], "zoneFactor": 1, "minHours": 6,
  "packs": [{ "productId": "promo.credits.499", "credits": 499 }, …], "devPurchases": false }
Quote { "radius": 2000, "daily": 269, "days": 3, "discountPercent": 10, "firstCharge": 269, "total": 684 }
Promotion { "radius": 2000, "daily": 269, "paidRate": 269, "status": "live|paused|stopped|ended",
  "startedAt", "paidUntil", "daysLeft": 2, "charged": 269, "refunded": 0, "refundable": 201 }
Wallet { "balance": 730, "accountToken": "uuid",
  "entries": [{ "id", "at", "amount": -269, "kind": "purchase|day|reversal|refund", "event"?: { "id", "title" }, "productId"? }] }
```

## Limits

| | |
|---|---|
| JSON request body | 256 KB (413 `too_large`); files go through uploads |
| Socket frame | 64 KB, at most 10 a second (bursts of 30): beyond, the socket is closed (1008) |
| Messages | 20 per 10 s per user |
| New direct chats | 30 per hour per user |
| Events created | 20 per hour per user |
| Events on at once | 5 per organizer (409 `too_many_events`) |
| Store purchases sent to be credited | 30 per hour per user |
| Upload tickets | 120 per hour per user, 20 waiting at a time |
| Profile and group pictures changed | 30 per hour per user |
| Profile changes | 300 per hour per user; another @handle 5 per day |
| People's profiles, avatars and lists read | 600 per minute per user |
| Events saved and unsaved | 120 per minute per user |
| Gestures, invitations whoever to | 60 per minute, 30 per hour per user |
| Running a chat (names, roles, mutes, pins, read-only) | 120 per hour per user |
| People blocked and unblocked | 60 per hour per user |
| New codes for a connect session | 30 per minute per user |
| All requests of one person | 3000 per minute |
| Groups | at most 256 people each, 50 owned |
| Photos | Albums, above |
| Reports | 20 per hour per user |
| Connect sessions, claims | 10 per minute per user each |
| Gestures, words to everyone | 1 per 2 s per pair, 1 per 10 s (the socket frames' rules) |
| Votes in polls | 30 per minute per user |
| Groups created | 20 per hour per user |
| People added to groups | 60 per hour per user |
| Joining and leaving events | 60 per minute per user |
| Ratings written | 30 per hour per user |
| Changes to events | 120 per hour per user |
| Avatars saved | 60 per hour per user |
| Copies of one's data | 5 per hour per user |
| Images | at most 60 megapixels (422 `moderated`) |

Errors the server did not expect answer 500 `{ "code": "internal" }` and nothing else.

## Security for the production backend

- **Configuration that must hold, or the server does not start** (`PRODUCTION=1`,
  `config.production_problems`): `API_RESOURCE` set (every token's `aud` checked, opaque
  tokens refused); no unverified tokens (`TRUST_UNVERIFIED_TOKENS`, off unless asked for,
  and only when Logto cannot be reached, never for a key it does not know); no
  development world (`DEV_TOOLS`, off unless asked for: test purchases, API
  documentation, demo people and events); public addresses set and HTTPS only.
- **A deleted account stays deleted**: its sockets are closed and a token issued before
  the deletion, still valid, is refused (401): it does not make the account again.
- **Every request is authorized on the server** against the current state: chat
  membership and role, event organizer, blocks either way (a blocked person is a 404,
  as if they did not exist), the presence rules. A cached or old ID gives no access.
- **Media**: uploads go straight to the storage through a signed URL valid minutes,
  for one purpose and size; the server checks the file is an image, strips EXIF (the
  GPS position first) and makes its own copies; files are served at random,
  immutable URLs (≥128 bits) from a CDN, never listed.
- **What the server hears is a fresh GPS fix.** Presence comes only from fixes at most 30 s old, and `GET /events` from a position at most 30 s old (connecting in person: 60 s from the phone, checked at 2 min here). A phone's older last known position may only draw its own map while the GPS starts, and is never sent: matching and what is around are always decided on fresh GPS. The server cannot prove any of this (a phone can say anything): `position_guard` below stops what is physically impossible.
- **Locations**: presence only while the map is visible, and one minute after leaving it with the app in front, in the chosen mode; never from the background;
  approximate mode never reveals the real place; nothing kept as history; event
  searches with a rounded point. The position is the phone's GPS and nothing else
  (never steps or other sensors), and a position from a fake-GPS app is not used.
  The server cannot prove a position, but refuses one no plane could have reached
  from the last (`position_guard.py`: presence, event searches, a flash event's
  `from`, connecting): 409 `position_rejected`, `too_far` on the last two. For that it
  keeps one point rounded to ~1 km per user, in memory, 16 h at most, gone with the account.
- **Logs and errors** never contain tokens, message texts or positions; errors the
  server did not expect answer `500 { code: "internal" }` only.
- **Abuse**: the rate limits below (per user, answering 429 with `Retry-After`), size
  limits on every body and frame, reports, blocks.
- **Accounts**: deletion removes everything of the user (`DELETE /me`); the data
  export is a one-time link valid 10 minutes.

## Performance notes for the production backend

How to build all this at scale, in Java: [JAVA-BACKEND.md](JAVA-BACKEND.md). Targets: p95 under 150 ms
for reads and 300 ms for writes at the server; the app's first screen with at most 6
parallel requests, most of them 304.

## How the app uses the API

So that the production backend sees the traffic it is built for:

- **Start**: shows what it kept (Caching), then asks in parallel `GET /me`, `/chats`,
  `/me/connections`, `/me/blocks`, `/me/events` and `/events` (with ETags) and opens
  the socket; then, in the background, brings the most recent changed chats up to
  date (`messages?limit=50`, then `after` when a hole is left; at most 50 chats).
- **Timeouts and retries**: 15 s per request. A read that failed is asked again when
  the connection comes back, when its screen comes into view, and (the profile) every
  20 s while it fails; the socket reconnects after growing pauses (1 s … 30 s). Writes
  are not repeated by themselves, except messages (the outbox); with
  `Idempotency-Key` **[planned]** they can be, after growing pauses with jitter (and
  after `Retry-After` when given).
- **The same thing is not asked twice at once** (an avatar, the nearby events, a
  chat's messages): a second ask waits for the first or replaces it.
- **Offline**: messages wait in an outbox and go when the connection is back (same
  `clientId`); every other change needs the connection and says so.
- **Background**: socket closed, presence gone after 45 s; new messages, connections
  and event changes arrive as push notifications **[planned]** (`POST /me/push-tokens`
  exists; the app does not register yet).

## Status

What is decided above and not built yet. The rest of this document is built, in the
development server and in the app, and checked by their tests (`make test`).

| | Backend | App |
|---|---|---|
| Public user IDs (`usr_…`) instead of the Logto `sub` | map `sub` → user | nothing (IDs are opaque) |
| Socket resume (`seq`, `resume`, `resumed`, `serverTime`) | per-user log of frames (10 min / 500) | keep the last `seq`; reload only when not resumed |
| Token refresh on the open socket | accept `auth` again, `ack` | send it before expiry |
| `Idempotency-Key` on the other creating POSTs (built for `POST /events` and `POST /events/{id}/photos`) | keep results 24 h per user and key | a key per action, the same on retries |
| `If-Match` on PATCH of events, groups, profile | compare with the current ETag, 412 | send it; on 412 reload and show |
| Push notifications | send them for messages, connections, event changes | register the token, open the right screen, `DELETE` it at sign-out |
