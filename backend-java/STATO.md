# Stato del backend Java

Il backend di produzione descritto in `docs/JAVA-BACKEND.md`, che realizza il contratto di
`docs/API.md`. Il riferimento di comportamento resta `backend/app` (Python). Questo file dice
cosa c'è e cosa manca: va tenuto vero a ogni passo.

## Come si avvia

Dalla cartella del progetto: `make dev JAVA=1` (PostGIS, jar, server su 7777 con `DEV_TOOLS` come il Python, poi Expo)
e `make test JAVA=1`. A mano:

```sh
cd backend-java
docker compose up -d --wait     # PostGIS 18 di sviluppo su 127.0.0.1:5433
./gradlew :app:bootRun          # porta 7777, tutti i ruoli; l'app lo trova da sola
./gradlew build                 # compila con Error Prone e NullAway, e fa tutti i test (Docker serve: PostGIS vero)
./gradlew :store:generateJooq   # dopo una nuova migrazione: rigenera le classi di jOOQ (da committare)
```

Variabili utili in sviluppo: `API_RESOURCE` (lo stesso valore di `EXPO_PUBLIC_API_RESOURCE`, consigliato), senza la
quale l'app manda token opachi controllati con l'userinfo di Logto; `PUBLIC_URL`, `MEDIA_URL`; l'elenco completo è in
`app/src/main/java/masterkey/app/Settings.java`. Con `PRODUCTION=1` il server non parte se la configurazione non è
sicura, e dice perché.

## Scelte iniziali (e dove differiscono dalla scheda)

| Scelta | Perché |
|---|---|
| Cartella `backend-java/`, Gradle 9.8.2 con wrapper, Kotlin DSL, catalogo `gradle/libs.versions.toml`, convenzioni in `buildSrc` | come §5 e §21; il daemon prende da solo un JDK 25 (`gradle/gradle-daemon-jvm.properties`) |
| Pacchetti `masterkey.<modulo>` | il nome interno del progetto |
| Error Prone + NullAway (JSpecify, ogni pacchetto `@NullMarked`), `-Xlint:all -Werror` dal primo file | §21: aggiunti dopo costano migliaia di righe |
| Il tempo dell'applicazione passa sempre da `InstantSource` e si dà a SQL come parametro: mai `now()` nelle query, niente `DEFAULT now()` nello schema | un solo orologio (Java e Postgres possono differire), e i test possono spostare il tempo come fa il Python. Anche Nimbus usa quell'orologio |
| **Utenti: `users.id` è un UUID tutto casuale (v4), l'id pubblico è `usr_` + i suoi 16 byte**: niente colonna `public_id` | stessa proprietà della scheda (nessuno ricava l'età di un account, 122 bit casuali), una ricerca in meno su ogni id in arrivo. Chat: `chat_…` dal loro UUID, `event:<id evento>` per le chat evento, niente `chats.public_id` |
| **Posizioni come due colonne `latitude`, `longitude` più `location geography` generata** | jOOQ OSS non ha i tipi spaziali: così il codice legge e scrive numeri, e PostGIS ha comunque la sua colonna con l'indice GiST. jOOQ non vede `location`: PostGIS si usa con SQL dove serve |
| Lo schema vero è `store/src/main/resources/db/migration` (Flyway, un file non cambia mai dopo essere stato applicato); le classi jOOQ si generano da lì su un PostGIS in Docker e stanno in `store/src/generated` | il §7.1 è stato il punto di partenza; da qui in avanti fanno fede le migrazioni |
| `poll_votes.chat_id` in più, `push_tokens.added_at`, `uploads.created_at`, controlli su lunghezze e handle nello schema | servivano alle regole (il più vecchio dei 10 token se ne va, un voto sparisce con la sua chat) |
| Un errore del server mentre si controlla il token: socket chiuso con 1011, REST 503 | il Python chiude con 4001, ma l'app con 4001 ritenta subito con un token nuovo: qui non è colpa del token, e l'app aspetta |
| Niente persone, eventi e messaggi demo | come dice il §11: stanno solo nel Python |
| L'immagine `postgis/postgis:18-3.7` esiste solo per amd64 | su un Mac con Apple Silicon Docker la emula (più lenta, funziona); i server di produzione sono x86 |
| db-scheduler senza lo starter di Spring Boot: `Scheduler` e `SchedulerClient` fatti a mano in `jobs` sulla data source di `Database` | `Database` ha il suo `TransactionTemplate` e non espone una `DataSource` a Spring: lo starter ne cercherebbe una. Lo stesso effetto (lavoro scritto nella transazione, dati in JSON, `pollUsingLockAndFetch`, polling 1 s) provato in `JobsTest` |
| Ogni file da cancellare passa da un lavoro `files.delete` scritto nella transazione (`Later`) | dopo il commit e prima della cancellazione una macchina può fermarsi: i file resterebbero (C11 della conservazione). Riprovato fino a circa due giorni |
| `events.chat_closed_at`, `events.chat_purged_at` (V2) | `chat.close` e `retention.sweep` sanno cosa hanno già fatto: girati due volte o in ritardo non rifanno niente |
| Indice unico `wallet_entries (store_key, kind)` (V2) | un acquisto si accredita e si storna una volta sola anche con due notifiche dello store nello stesso istante |
| `APPLE_APP_ID` in più (l'id numerico dell'app) e `APPLE_ONLINE_CHECKS` (acceso salvo `0`) | `SignedDataVerifier` di Apple lo richiede in Production; il controllo di revoca dei certificati in linea è quello consigliato da Apple. `PRODUCTION=1` rifiuta il controllo spento |
| `DELETE /me`: i messaggi dell'account nelle chat che restano diventano "Message removed" (testo, sondaggio e autore tolti, voti e messaggi fissati con loro), a lotti nel lavoro `account.erase` | il Python li toglie del tutto; qui contatori, non letti e ultimo messaggio sono numeri sulla riga della chat (§18) e toglierli li farebbe sbagliare. Nessun dato della persona resta; l'app mostra già così un messaggio cancellato |
| Identità su Logto cancellata dal lavoro `identity.delete` (Management API, applicazione M2M: `LOGTO_M2M_APP_ID`, `LOGTO_M2M_APP_SECRET`, `LOGTO_MANAGEMENT_RESOURCE` per un Logto non Cloud) | C14 della conservazione; ripetuto per circa tre giorni se Logto non risponde. `PRODUCTION=1` non parte senza |
| La copia dei dati si scrive su un file temporaneo dentro una transazione di sola lettura, poi si manda | un telefono lento non tiene una connessione del database, e una storia lunga non sta tutta in memoria. Il filtro degli ETag non tocca `/v1/exports/` e `/v1/media/` |
| R2 con il client HTTP del JDK (`url-connection-client`), senza Netty e Apache; checksum solo quando richiesti | meno dipendenze; i checksum predefiniti degli SDK recenti R2 non li accetta tutti (lo dice Cloudflare) |
| `X-Content-Type-Options: nosniff` sui file pubblici va messo dalla CDN (regola di trasformazione delle risposte su Cloudflare) | non è un metadato che un oggetto S3/R2 possa portare; `Content-Type` e `Cache-Control` sì, e li scrive `imaged` |
| APNs senza Pushy: `HttpClient` HTTP/2 del JDK e JWT ES256 firmato con Nimbus (rifatto ogni 50 minuti) | Pushy porta Netty 4.1, mentre il BOM di Spring Boot 4 ne gestisce un'altra linea: un conflitto evitato. Il protocollo di APNs è una richiesta HTTP/2 per notifica |
| Push di una chat diretta dopo 5 s, di un gruppo o di un evento dopo 30 s (sempre una riga in coda per chat, col conteggio) | 30 s in una chat a due sono un'attesa che si nota; il raggruppamento resta, e il rumore delle chat grandi pure |
| `chat_members.pushed_counter` (V3) | ognuno è avvisato una volta sola per messaggio, anche se il lavoro gira due volte |
| Il "muto" delle chat è moderazione (non può scrivere), non silenzia le push | così dice `API.md`; per le push conta solo `notifyMessages` |
| Promozioni e wallet nel pacchetto `api/money`, con un ordine fisso dei lock: persona, evento, promozione, wallet | due transazioni di denaro non si aspettano mai a vicenda; il Python girava su un thread solo e non ne aveva bisogno |
| `promotion.charge` una promozione per transazione, presa con `SKIP LOCKED` | una che fallisce non ferma le altre, e una richiesta che la sta cambiando non viene aspettata: la si riprende al minuto dopo |

## Fatto

- `core`: `ApiError`, `Json`, `Body`, `Text`, `Ids`, `Geo`, `Point`, `Times`, con test.
- `presence` (§4, §5): `Engine` a thread unico (tre PH-Tree sulla sfera, i 25 con connessioni → saluti → vicini e
  vantaggio 0,85, `considerAdd`, delta per versione dei record, `known` per socket, `audience`, TTL 45 s, position
  guard, punti d'area HMAC, gesti con 0,3 s, annunci, inviti, ricerche eventi con indice proprio), `PresenceService`
  (code `frames`/`control`, giro 0,5 s, matching a fette, watchdog). Test: 27 scenari, 24 vite casuali che controllano
  coerenza delle coppie, ciò che mostra ogni telefono, privacy di ogni record ed esattezza contro il calcolo su tutti;
  indice contro forza bruta (poli, antimeridiano, punti uguali); il thread vero.
- `bus`: interfaccia + `LocalBus` in-process (soggetti `u.<utente>`).
- `gateway`: socket Jetty (`PhoneSocket`), `auth` entro 5 s su virtual thread, `ready`, scadenza del token 4001,
  10/s raffiche 30 (1008), 64 KB (1009), 500 in uscita (1013), ping 25 s, niente permessage-deflate, scrittori per
  gruppo di socket, frame dal bus, chiusura graduale. Test con Jetty e client WebSocket veri.
- `store`: migrazione `V1__schema.sql`, generatore jOOQ (`generateJooq`), `Database` (pool Hikari con attesa massima 2 s
  → 503, `tx`/`read` con `TransactionTemplate`, un secondo tentativo su deadlock, lock consultivi per persona e zona,
  nome del vincolo violato). `TestDatabase` (test fixture): un PostGIS per JVM, un database nuovo per classe di test.
- `auth`: `TokenVerifier` (JWT `at+jwt` o `JWT` con la JWKS in cache, un minuto di tolleranza, `aud` quando c'è
  `API_RESOURCE`; token opaco con l'userinfo solo senza; `TRUST_UNVERIFIED_TOKENS` solo se Logto non risponde; cache per
  hash fino a `exp`; account cancellati), ID token anche scaduto, `X-Profile-Hint` solo fuori produzione, `AppVersion`.
  Test con le falsificazioni del §16.
- `api`: errori `{code, message}` anche per quelli di Spring, `Guard` (426, 411, 413), `Etags` (W/, 304), `Viewer`
  (utente corrente), `Limits` (la tabella di `API.md`), `Accounts` (account al primo accesso, nomi solo da ciò che Logto
  firma, handle libero con numero, mai riservato, gara di due primi accessi), `GET/PATCH /me`.
- `app`: `Main` con i ruoli e i controlli di produzione, `Settings`, Jetty con `/v1/ws` sulla stessa porta e i suoi
  errori in JSON, `DbDirectory` per la presenza (relazioni, riassunti, notifica `connect.invite`), `Health`.
- Servizi condivisi (`api/common`): `Outbox` (i frame partono dopo il commit, un rollback li butta), `People`
  (UserSummary a lotti), `Relations` (blocchi nei due versi, connessioni, coppie disconnesse, `sees_story`, chi può
  scrivere a chi con la presenza in 200 ms), `ChatPush`.
- Eventi (`api/events`): ricerca PostGIS (normali e promossi, uniti, 200 al massimo, cache 15 s della parte pubblica,
  `searchedEvents` alla presenza), `EventViews` per ciascun lettore a lotti, creazione con lock sulla persona e sulle
  caselle della zona (15 m, 5 attivi, chiave di idempotenza), evento flash entro 500 m, modifica, annullamento con
  rimborso della promozione, partecipanti (posti dei flash con un `UPDATE` condizionale, 200 a testa), salvati (1000),
  `saved_hidden`, voti con contatori, `EventNotifier` (frame `event` personali a chi è coinvolto e a chi ha il posto tra i
  suoi eventi), `Promotions` (lettura, rimborsi), tema dell'evento del §16.
- Notifiche (`api/notifications`): raggruppate entro 24 h, impostazioni, mai chi è bloccato, le 100 più recenti, frame
  `notification`; `GET /me/notifications`, `POST …/read`.
- Chat (`api/chats`): dirette, gruppi, eventi; `seq`/`counter` sulla riga della chat, non letti per differenza (lento solo
  con blocchi), `joined_seq`, `clientId` + `sent_messages` anche con due invii insieme, pagine `before`/`after`, letto
  che non torna indietro e `chat.read`, moderazione (ruoli, muto, sola lettura, 3 messaggi fissati), sondaggi con
  `mine` solo nelle risposte, cancellazione di un messaggio, passaggio del gruppo, fine del gruppo.
- Persone (`api/people`): profili altrui, eventi, storia (momenti nascosti, tipi), connessioni con le comuni, token push
  (10, il telefono passa di account), consensi, connessioni e disconnessioni, blocchi con tutti gli effetti del §8,
  segnalazioni con l'istantanea, connessione di persona con il QR (sessioni e codici da 10 s in RAM, distanza, posto
  dell'incontro).
- File (`api/media`, §19): ticket firmati, `PUT /v1/storage/…` in sviluppo, claim (a) in una transazione breve con i nomi
  delle uscite, immagini (b) fuori da ogni transazione, uso (c) nella transazione di chi lo usa; rifiuto → upload usato,
  `imaged` occupato → 503 e upload di nuovo nominabile. Foto profilo, copertine, foto dei gruppi, album con permessi e
  limiti. `DevImaging` solo in sviluppo; `ImagedClient` verso il programma `imaged`.
- Storage R2 (`R2Storage` nell'API, `S3Store` in `imaged`): PUT firmato con tipo e lunghezza esatti (gli header da
  mandare sono nella risposta, `Content-Length` lo mette il client), cancellazione a lotti di 1000 nei due bucket, purge
  per URL su Cloudflare (30 per chiamata); `imaged` chiede la dimensione, poi legge al massimo quella, pubblica JPEG con
  `Cache-Control` immutabile, cancella l'originale. **Provato contro un server S3 vero che controlla le firme**
  (SeaweedFS 4.45 in Docker): corpo più lungo o di altro tipo del firmato rifiutato. Senza `R2_*` resta la cartella di
  sviluppo, e `PRODUCTION=1` non parte.
- `imaged`: programma a parte con la CLI di libvips (`VIPS_BLOCK_UNTRUSTED`, un processo per immagine, 20 s, metadati
  tolti, rotazione EXIF, sRGB). **Provato in Docker con libvips vero**: foto ruotata, nessun EXIF rimasto, JPEG tagliato
  rifiutato, GIF rifiutata, bomba di pixel rifiutata, originali cancellati.
- Avatar (`api/avatars`): catalogo e preset con le regole di `avatarFormat.js`, mappa dal baker in background (una lettura
  non aspetta mai, il salvataggio al massimo 5 s), ETag.
- Denaro (`api/money`, passo 8): listino, preventivo, avvio/cambio/ripresa/stop della promozione con 402
  `insufficient_balance` e 409 `price_changed` (dettagli come il Python), rimborso all'annullamento e all'accorciamento,
  wallet con le ultime 50 voci, acquisti verificati con le librerie ufficiali (`SignedDataVerifier` di Apple con radice,
  tipo dei certificati, revoca in linea, app e ambiente; Play Developer API con stato, tipo di acquisto e account), una
  volta per transazione, `dev` solo con `DEV_TOOLS`, notifiche di rimborso di Apple (firmate) e Google (`?secret=`, a
  tempo costante). Prezzi confrontati con il Python caso per caso (`PromotionsTest`).
- Lavori (`jobs`, §8): `cleanup.sweep` (upload, `sent_messages` e `idempotency_keys` dopo 24 h, link di esportazione,
  `erased_accounts` dopo 2 h, notifiche oltre 60 giorni, finestre dei limiti), `promotion.charge`, `event.remind`,
  `chat.close`, `retention.sweep` (C4-bis chat evento a 30 giorni, C5-bis eventi a 12 mesi con i file, C6 segnalazioni a
  12 mesi), `files.delete`. Dati in JSON, mai serializzazione Java.
- Diritti (`api/privacy`, passo 9): `DELETE /me` in una transazione sotto il lock della persona (eventi suoi con tutto ciò
  che ne dipende e `event.cancelled` col titolo a chi andava, contatori degli eventi altrui, chat dirette tolte, gruppi
  passati o chiusi senza messaggi col suo nome, il suo nome tolto dalle notifiche altrui, segnalazioni senza di lei,
  upload, wallet con gli acquisti che restano noti, `erased_accounts`), poi socket chiusi con 4001, presenza, sessioni di
  connessione, limiti e token dimenticati; file, messaggi e identità su Logto come lavori. `POST /me/export` (link di
  10 minuti, solo l'hash salvato) e `GET /exports/{token}` una volta sola, con gli stessi campi del Python.
- Push (`jobs/push`, passo 7): APNs e FCM HTTP v1 diretti (D5), `push.notify` (una notifica, 5 s dopo, se non è
  stata letta e la persona non è online) e `push.chat` (il conteggio dei nuovi, mai il testo; chi è online no; mai
  di chi ha un blocco; negli eventi solo organizzatore e admin; i gruppi da `joined_seq`); i token che Apple o Google
  dicono finiti si tolgono. Senza `APNS_*` o `FCM_SERVICE_ACCOUNT_FILE` quei telefoni non ricevono push (un avviso
  all'avvio). **L'app non registra ancora i token** (`API.md`, Status): va fatto con `getDevicePushTokenAsync`.
- Test end-to-end sul server intero (token firmati da un finto Logto, PostGIS vero, socket, worker vero): avvio minimo,
  eventi e chat, persone, file, avatar, denaro, lavori (anche: un lavoro esiste solo se la sua transazione è confermata),
  diritti, push. I confini del §5 e i divieti del §21 controllati da ArchUnit (`BoundariesTest`).

## Provvisorio o mancante dentro ciò che c'è

- R2 vero non provato (serve l'account): va verificato che **R2** rifiuti un corpo più lungo del firmato, come fa
  SeaweedFS (§19); se non lo fa, `uploadUrl` passa da un piccolo Worker (l'app non cambia).
- Push mai provate con Apple e Google veri (servono la chiave .p8, il progetto Firebase e l'app che registra i token).
- Acquisti Apple e Google: scritti con le librerie ufficiali ma **mai provati con ricevute vere** (servono un'app sugli
  store e un account di prova); provati solo i rifiuti e la strada `dev`.

## Da fare, nell'ordine del §13

1. Prova di carico della presenza sulla macchina vera, con socket veri (strumento da scrivere, `docs/JAVA-BACKEND.md`).
2. ~~Base~~ fatto, collegata a `make dev JAVA=1` e `make test JAVA=1`.
3. ~~Persone~~ fatto (resta l'avatar, col passo 6).
4. ~~Eventi~~ fatto (restano album e immagini, col passo 6).
5. ~~Chat~~ fatto (resta la foto dei gruppi, col passo 6).
6. ~~File e code~~ fatto, R2 compreso (resta la prova su R2 vero).
7. ~~Notifiche e push~~ fatto (resta la registrazione dei token nell'app e la prova vera).
8. ~~Denaro~~ fatto (resta la prova con ricevute vere).
9. ~~Diritti~~ fatto: `DELETE /me`, esportazione, conservazione. Resta la moderazione (strumenti per chi gestisce le
   segnalazioni: oggi le segnalazioni si salvano, nessuna rotta le legge) e C3-bis (account inattivi, da decidere).
10. Scala: NATS, Valkey, ruoli separati (oggi `Main` rifiuta i ruoli senza `api`).
