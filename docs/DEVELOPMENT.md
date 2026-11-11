# UnnamedApp: guida per lo sviluppo

App Expo (Expo Router) con una mappa 3D del quartiere (three.js in una WebView),
avatar 3D, eventi, chat e connessioni di persona. In sviluppo gira tutto sul Mac: il
backend Python, i tile della mappa e gli asset degli avatar.

## Requisiti

- macOS o Linux con Node 24 (≥ 24.3) o ≥ 26 (Expo SDK 58 non supporta le versioni dispari), git, make e [uv](https://docs.astral.sh/uv/)
  (macOS: `brew install uv`; Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`, più `unzip` e `lsof` o `ss`)
- iOS (solo macOS): Xcode, con il tuo Apple ID in Xcode › Settings › Accounts
- Android: JDK 17 e l'SDK Android (`~/Library/Android/sdk`, `~/Android/Sdk` o `ANDROID_HOME`)
- Backend Java (`JAVA=1`, cartella `backend-java/`, stato in `backend-java/STATO.md`): JDK 25 e Docker
- Telefono e computer sulla **stessa Wi-Fi**: l'app trova i server all'indirizzo del computer
  (su Linux il firewall deve lasciare entrare le porte 8081, 7777, 8092, 8093)

## Comandi

| Comando | Cosa fa |
|---|---|
| `make dev` | prepara ciò che manca, riavvia i server, avvia Expo con il QR code (`JAVA=1`: il backend Java di produzione al posto di quello Python, con PostGIS in Docker e il JDK 25; `NO_BACKEND=1`: nessun backend) |
| `make build` | build di release: `build/app.apk` (Android) e `build/app.ipa` (iPhone) |
| `make test` | lint, test dell'app, del backend, di `three-geo-play` e di `tile-provider` (`JAVA=1`: anche build e test del backend Java, qualche minuto, serve Docker) |
| `make map-bench` | misura la velocità della mappa in Chrome (con `make dev` avviato): tempo GPU per frame e per parte, thread principale, memoria, eventi e persone ricevuti; `REF=<commit>` confronta con un'altra versione |
| `make map-bench-people` | quanto costa ogni persona in più sulla mappa: CPU, GPU, memoria GPU (`COUNTS=0,50,100`) |
| `make demo` | l'app intera per il browser in `show-case/demo/`, la prova del sito vetrina: il backend Python gira nella pagina con Pyodide (serve il server degli avatar di `make dev`). Si pubblica su GitHub Pages con `.github/workflows/pages.yml`: fai il commit di `show-case/demo/` e in Settings › Pages scegli *GitHub Actions* |
| `make site` | il sito vetrina su http://localhost:8099 (la demo non parte aprendo `index.html` come file) |
| `make kill` | ferma tutti i server ed Expo e libera le porte |
| `make clean` | `make kill`, poi cancella tutto ciò che git ignora |

### `make dev`

1. **Setup**: ogni passo parte solo se il suo risultato manca o è più vecchio di ciò da
   cui nasce, quindi dal secondo avvio si arriva subito a Expo.
   - `npm install` dell'app e dei sottoprogetti `webview/` e `asset-pipeline/`
   - build delle due pagine WebView in `assets/webview/` (mappa e viewer avatar)
   - ambiente Python del backend (`backend/.venv`, con uv)
   - tile della mappa: se `tile-provider/output/` è vuota crea Roma (serve Docker, che su
     macOS viene acceso da solo; circa tre minuti). Un'altra area al primo avvio:
     `make dev TILES_AREA=new-york`; altre aree in più: `make -C tile-provider tiles AREA=…`
   - asset avatar Decentraland: clone di circa 1,2 GB, catalogo, copie ottimizzate per la
     GPU (circa 10 minuti la prima volta), avatar della mappa
2. **Server**: tile, avatar e backend vengono riavviati a ogni lancio; i log sono in `.dev/logs/`.
3. **Simulatori iOS**: ogni simulatore acceso (anche dopo) riceve il permesso di
   posizione per l'app e un GPS su Roma; senza, la mappa non disegna nulla. Dove
   `tile-provider/output/` non ha un'area la mappa resta vuota. Altrove: `make dev SIM_LOCATION=45.4642,9.19`.
4. **Expo**: `make dev` avvia Metro per il development client. Al primo uso Android,
   installa la build nativa con `npx expo run:android --no-bundler`; su un telefono
   aggiungi `--device`. Poi premi `a` in Metro per l'emulatore, o apri il development
   client sul telefono e inquadra il QR. Ctrl+C ferma Expo e tutti i server.

`make dev PROD=1` serve il JavaScript minificato, come in una release.

**Expo Go** può servire per una rapida anteprima dell'interfaccia, ma non per provare il
login Logto su Android: Expo Go non registra lo schema privato
`projectexpofrontend://callback`, quindi la pagina di Logto può restare aperta dopo il
login. `make dev` usa il development client; crea la build nativa una volta con
`npx expo run:android --no-bundler` (o `npx expo run:ios --no-bundler`). Ricompilala
quando cambiano dipendenze native, `app.json`/`app.config.js` o `modules/`.

### `make build`

Le build di release contengono il JavaScript, ma parlano con i server del Mac, che
usano l'indirizzo Wi-Fi rilevato al momento della build: per provarle in locale tieni
acceso `make dev`.

Per usare endpoint online, passa URL HTTPS e `API_RESOURCE`, l'audience dell'API registrata in
Logto (serve per un token che il backend può verificare), e `TILE_URL`, il TileJSON dei
tile di `tile-provider/` messi online (la mappa non ha altre sorgenti):

```sh
make build API_URL=https://api.example.com/v1 AVATAR_URL=https://assets.example.com API_RESOURCE=https://api.example.com \
  TILE_URL=https://tiles.example.com/tiles.json
```

Si possono fare separatamente con `make build-android` e `make build-ios`.

- **Android**: invia l'APK al telefono e aprilo ("Installa app sconosciute"), oppure
  `adb install -r build/app.apk`.
- **iPhone (Apple ID gratuito)**: l'iPhone deve essere abbinato a Xcode, con la Modalità
  sviluppatore attiva. Installa `build/app.ipa` da Xcode › Window › Devices (trascinalo sul
  telefono), poi sull'iPhone: Impostazioni › Generali › VPN e gestione dispositivi › dai
  fiducia al tuo Apple ID. L'app scade dopo 7 giorni.
- **Nel cloud** (EAS, senza cavi): `npx eas-cli build -p all --profile preview`
  (`eas.json`; per iPhone serve l'account sviluppatore a pagamento). Prima configura
  nell'ambiente EAS `preview` le variabili `EXPO_PUBLIC_API_URL`,
  `EXPO_PUBLIC_AVATAR_URL`, `EXPO_PUBLIC_TILE_URL` (senza, la mappa non ha tile) e
  `EXPO_PUBLIC_API_RESOURCE` con i valori online HTTPS. Il profilo EAS
  non contiene indirizzi locali né audience dimostrative.

### `make clean`

Cancella dipendenze, `ios/`, `android/`, `build/`, i dati del backend (`backend/.data`:
mondo demo e foto) e tutti gli asset avatar: il `make dev` successivo li riscarica e li
ricalcola. Restano i file `.env` e le chiavi di firma.

## Server

| Porta | Server | Codice |
|---|---|---|
| 8081 | Metro (Expo) | |
| 7777 | Backend: API REST + WebSocket, docs su `/v1/docs` | `backend/` |
| 8092 | Asset avatar: catalogo, file, avatar della mappa | `avatar-server/` |
| 8091 | Mappa nel browser, solo per lavorarci: `npm --prefix webview/map run dev` | `webview/map/` |
| 8093 | Tile della mappa: tutte le aree di `tile-provider/output/` come un'unica sorgente, `/tiles.json` | `tile-provider/scripts/serve.mjs` |

Variabili del backend: `PERSIST=0` (riparte vuoto), `DEV_TOOLS=0` (niente mondo di prova),
`TRUST_UNVERIFIED_TOKENS` (solo sviluppo; **0** in produzione), `PUBLIC_URL`,
`ASSETS_URL` (`backend/app/config.py`).

## Com'è fatto

```
src/app/          solo route (Expo Router): ogni file importa una schermata da src/features/
src/features/     una cartella per funzione: map, events, social, profile, avatar, auth, api, realtime…
src/components/   UI condivisa (tab bar, bottoni); src/theme/colors.js: palette chiara e scura
src/web/          sostituti per la versione web (la WebView diventa un iframe)
test/             test dell'app (node --test)
webview/map/      la mappa 3D (three.js + three-geo-play) → assets/webview/map.html
webview/avatar/   il viewer degli avatar 3D → assets/webview/avatar.html
webview/three-geo-play/  la libreria dei tile 3D (modifiche nel suo CHANGELOG)
backend/          backend di sviluppo FastAPI, il riferimento del comportamento
backend-java/     il backend di produzione (Spring Boot); stato in backend-java/STATO.md
docs/             API.md (il contratto app-backend), JAVA-BACKEND.md (il progetto del backend
                  di produzione), PROMOTIONS.md, CONNECT-PROTOCOL.md, ART-DIRECTION.md
avatar-server/    asset avatar; shared/avatarFormat.js è il formato usato da app e backend
asset-pipeline/   ottimizzazione offline degli avatar (texture ASTC KTX2, geometria meshopt)
tile-provider/    crea e serve i tile zoom 16 (make tiles AREA=roma, vedi tile-provider/README.md)
legal/            privacy, termini, licenze (bozze per l'avvocato: vedi legal/README.md)
scripts/          avvio dello sviluppo (make dev) e generazione dei testi legali
show-case/        il sito vetrina, la demo nel browser (demo/, make demo) e gli strumenti per le registrazioni
```

- **Niente mock**: l'app usa le API di `docs/API.md` (REST + un WebSocket) come farà
  con il backend di produzione. `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_AVATAR_URL`,
  `EXPO_PUBLIC_TILE_URL` e `EXPO_PUBLIC_API_RESOURCE` puntano altrove; senza, in sviluppo,
  si usano i server del Mac. I tile vengono **solo** da `tile-provider/`: nessun provider
  esterno, nemmeno come riserva.
- **Pagine WebView**: sono un unico file HTML ciascuna (la WebView le carica da `file://`) e
  sono **committate**, perché le build le usano così come sono. `make dev` le ricompila
  quando cambiano i sorgenti; dopo una modifica premi `r` in Metro.
- **Avatar**: l'app li richiede in ASTC da `/v1/files-astc/` se la GPU lo supporta, altrimenti
  usa gli originali.
- **Login**: solo Logto (`src/features/auth/logtoConfig.js`), redirect `projectexpofrontend://callback`.
- **Testi legali**: dopo una modifica ai documenti o alle dipendenze rigenera ciò che l'app
  mostra con `node scripts/legal.mjs`.

## Regole del codice

- I file in `src/app` restano sottili e contengono solo route: Expo Router tratta come
  route ogni file che si trova lì.
- Il codice usato da una sola funzione sta nella sua cartella; va in `src/components`
  o `src/lib` quando serve anche a una seconda.
- Link a eventi e profili sempre con `useTabLinks()`, mai `/event/…` diretto: il Back torna
  dove si era e la tab bar resta.
- Colori solo da `useColors()`: l'app segue il tema chiaro o scuro del telefono.
- La tab bar galleggia ed è traslucida: le pagine arrivano fino in fondo allo schermo e
  aggiungono in basso lo spazio di `useTabBarHeight()`.
- Le tab non usano `freezeOnBlur`: con i cambi rapidi di tab lasciava la mappa sopra le
  altre tab.
- Uno sheet (formSheet) con una ScrollView va avvolto in
  `<View collapsable={false} style={{ flex: 1 }}>`.
- Ogni avatar 3D è una WebView (circa 250 MB): `AvatarView` resta vivo solo mentre la sua
  schermata è visibile (`useScreenVisible`).
- Le persone sono sempre `UserSummary` per id; sono le regole del server a decidere chi vede
  chi (mappa, chat, connessioni).

## Problemi comuni

| Sintomo | Soluzione |
|---|---|
| Porte occupate | `make kill` |
| Un server non parte | guarda `.dev/logs/<server>.log` |
| Il telefono non vede i server | stessa Wi-Fi del computer; firewall (Linux); per le release ricompila se l'IP è cambiato |
| Linux: `ENOSPC`, "file watchers" | `sudo sysctl fs.inotify.max_user_watches=524288` |
| Linux: "compiling astcenc failed" | glibc più vecchia di Ubuntu 24.04: `sudo apt install cmake g++` |
| Nessuno sulla mappa | scegli Visible; nel simulatore `xcrun simctl location booted set 41.8953,12.4918` |
| Dati demo strani | `make kill`, cancella `backend/.data/`, `make dev` |
| Una modifica nativa non si vede | ricompila la build (`npx expo run:ios` / `make build`) |

## Autore

Lorenzo Mezzabarba. Tutti i diritti riservati, vedi `LICENSE`.
