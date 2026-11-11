# Pacchetto legale e privacy

Bozze preparate a partire dal codice dell'app (non da un modello generico), da far **rivedere a un avvocato** prima del lancio. Ogni affermazione sui dati descrive ciò che il codice fa davvero; dove qualcosa non è ancora attuato è indicato. Le parti tra parentesi quadre (`[RAGIONE SOCIALE]`, `[privacy@DOMINIO]`, …) sono da completare.

## Contenuto

| File | Destinatari | Note |
|---|---|---|
| `en/privacy-policy.md`, `it/informativa-privacy.md` (+ `-short`, `-breve`) | Utenti (in app: Settings → Privacy policy; in italiano se il telefono è in italiano) | Artt. 13–14 GDPR |
| `en/terms-of-use.md`, `it/termini-di-utilizzo.md` (+ `-short`, `-breve`) | Utenti (in app e nella schermata di accesso) | Contratto, DSA, Codice del consumo |
| `en/community-guidelines.md`, `it/linee-guida-community.md` (+ `-short`, `-breve`) | Utenti | Parte dei Termini |
| `THIRD-PARTY-NOTICES.md` | Tutti (in app: Settings → Licenses) | Generato: solo ciò che l'app distribuisce davvero sotto una licenza che impone la nota (105 opere, asset, dati) |
| `it/compliance/registro-dei-trattamenti.md` | Interno | Art. 30 GDPR |
| `it/compliance/dpia-geolocalizzazione.md` | Interno, DPO | Art. 35 GDPR — obbligatoria |
| `it/compliance/valutazione-legittimo-interesse.md` | Interno | LIA per sicurezza e moderazione |
| `it/compliance/conservazione-dati.md` | Interno | Termini e stato di attuazione nel codice |
| `it/compliance/fornitori-e-trasferimenti.md` | Interno | Art. 28, Capo V |
| `it/compliance/procedura-diritti-interessati.md` | Interno | Artt. 12–22 |
| `it/compliance/procedura-data-breach.md` | Interno | Artt. 33–34, modello di registro |
| `it/compliance/moderazione-e-dsa.md` | Interno | Reg. (UE) 2022/2065 |
| `it/compliance/misure-di-sicurezza.md` | Interno | Art. 32 |
| `it/compliance/etichette-privacy-store.md` | Pubblicazione | Apple App Privacy, Google Data safety |

Dopo ogni modifica ai documenti o alle dipendenze: `node scripts/legal.mjs` (rigenera i testi mostrati dall'app e gli avvisi delle licenze).

**Quali licenze sono elencate.** Solo quelle che, se omesse, violerebbero la licenza: le opere che finiscono davvero nell'app (moduli del bundle JavaScript ricavati dalle source map, moduli nativi collegati alla build di rilascio, pacchetti delle pagine WebView ricavati da esbuild, librerie C++ compilate da React Native, font Ionicons, asset degli avatar, dati della mappa e del meteo) e la cui licenza richiede la nota nelle copie distribuite (MIT, BSD, ISC, Apache-2.0, CC BY, ODbL). Esclusi gli strumenti di sviluppo e di build (non distribuiti) e le licenze che non chiedono nulla per il codice compilato (CC0, 0BSD, Unlicense, MIT-0, BSL-1.0 come boost, fmt con la sua eccezione per i binari, zlib). Le tile della mappa sono nostre (`tile-provider/`, da dati OpenStreetMap con lo schema OpenMapTiles): chiedono solo l'attribuzione di OpenStreetMap e OpenMapTiles.

## Cosa è già attuato nel codice (verificato da test)

- Cancellazione completa dell'account in app, compresi file su disco, messaggi e foto pubblicati ovunque (`backend/app/privacy.py`, `tests/test_privacy.py`).
- Copia dei propri dati (artt. 15 e 20): Settings → "Download my data", link monouso di 10 minuti a un JSON.
- Registro del consenso alla condivisione della posizione, con versione del testo (art. 7, par. 1).
- Avvio sempre in modalità Invisible (privacy by default, art. 25).
- Posizione mai conservata: solo l'ultima, in memoria, 45 secondi.
- Modalità Approximate resistente a media e trilaterazione: griglia di 300 m, scostamento derivato da una chiave segreta del server, raggio calcolato sul punto mostrato (`tests/test_area.py`). Prima di questa revisione il punto era ricalcolabile dall'ID utente e la posizione esatta era ricavabile.
- Metadati EXIF (compreso il GPS) rimossi dalle immagini caricate; immagini sostituite o rimosse cancellate dal disco.
- Conservazione: chat degli eventi 30 giorni dopo la fine, eventi 12 mesi dopo la fine, segnalazioni 12 mesi (`privacy.retention_sweep`).
- Documenti in app in inglese e italiano (art. 9 Codice del consumo), leggibili anche senza account; riga di accettazione nella schermata di accesso.
- Attribuzione di OpenStreetMap e OpenMapTiles in Settings → Licenses, con il link a openstreetmap.org/copyright (non sulla mappa, per scelta di prodotto: vedi punto 18); avvisi di licenza per tutto ciò che l'app distribuisce e che li richiede.
- Ogni documento per gli utenti ha due versioni nell'app: "In breve" (mostrata per prima, linguaggio semplice) e "Testo completo". La versione breve dichiara che in caso di differenze vale il testo completo; va rivista insieme a quella completa a ogni modifica.
- L'app importa solo il font Ionicons (`@expo/vector-icons/Ionicons`): l'indice del pacchetto includeva tutti i 19 font di icone, tra cui Entypo (CC BY-SA 4.0) e le icone FontAwesome (CC BY 4.0), che avrebbero richiesto attribuzioni proprie (e 4,5 MB in più).

## Punti aperti per il legale

1. **Titolare e contatti**: ragione sociale, sede, P.IVA, PEC, indirizzi email (privacy, supporto, legal per il DSA, autorità).
2. **DPO**: probabilmente obbligatorio (art. 37, par. 1, lett. b): il monitoraggio della posizione tramite app è citato dal WP243 come esempio di monitoraggio regolare e sistematico; resta da valutare la "larga scala".
3. **Età minima e verifica**: scelto 18+ per il rischio (incontri con sconosciuti, posizione). Oggi è una dichiarazione nella schermata di accesso, senza passaggi in più (scelta di prodotto: nessuna frizione). Valutare se basta alla luce dell'art. 28 DSA, delle linee guida della Commissione sulla tutela dei minori e delle iniziative AGCOM sulla verifica dell'età.
4. **Base giuridica della condivisione della posizione**: proposto il consenso (art. 6.1.a), revocabile scegliendo Invisible; confermare o valutare il contratto.
5. **Accettazione dei Termini**: oggi una riga sotto i pulsanti di accesso ("By continuing you accept…"). Valutare se serve una casella o un'accettazione specifica di clausole (artt. 1341–1342 c.c., clausole vessatorie ex artt. 33 ss. Codice del consumo: limitazioni di responsabilità, sospensione, modifiche unilaterali).
6. **Messaggi non cifrati end-to-end**: dichiarato nell'informativa; valutare se opportuno cifrarli.
7. **DSA**: dimensione dell'impresa (esenzioni della Sezione 3); strumento per comunicare le motivazioni (art. 17) e gestire i reclami (art. 20) da realizzare; indirizzo per le segnalazioni di chiunque (art. 16).
8. **Fornitori**: hosting (consigliato UE), regione del tenant Logto, DPA firmati, eventuali TIA per gli USA (Expo per le notifiche).
9. **Tile della mappa**: servite solo dai nostri server (`tile-provider/`), nessun provider esterno; da indicare il fornitore di hosting / CDN che le servirà. Open-Meteo: verificare i termini per uso commerciale.
10. **Marchi negli asset avatar**: la libreria Decentraland è Apache-2.0, ma la licenza **non concede diritti sui marchi** (Apache-2.0, sez. 6). Alcune collezioni richiamano marchi o persone di terzi: `atari_launch` (10 capi), `dg_atari_dillon_francis` (2), `rtfkt_x_atari` (2), `binance_us_collection` (2), `winklevoss_capital` (2), `3lau_basics` (6), `release_the_kraken` (6), `dcl_launch` (20, marchio Decentraland), altre collaborazioni (`mch_collection`, `ethermon_wearables`, `cybermike_cybersoldier_set`…). **Raccomandato** limitare il catalogo alle collezioni generiche (es. `base-avatars`, stagionali) o ottenere un parere caso per caso; non usare il nome o il logo di Decentraland.
11. **Nome e marchio dell'app**: oggi "UnnamedApp"; ricerca di anteriorità prima della scelta (UIBM, EUIPO).
12. **Store**: su iOS serve "Sign in with Apple" perché l'app offre "Continue with Google" (Guideline 4.8); Google Play richiede una pagina web per chiedere la cancellazione dell'account; entrambi chiedono l'URL pubblico dell'informativa → pubblicare i documenti su un sito.
13. **Da attuare prima del lancio** (vedi `conservazione-dati.md`): account inattivi, conservazione dei log, backup, cancellazione dell'identità su Logto.
14. **Funzioni a pagamento**: la promozione degli eventi con crediti acquistati in-app (docs/PROMOTIONS.md) ha una bozza nei Termini (sezione 5-bis) e nell'informativa (3.8). Da verificare: diritto di recesso per contenuti digitali e consenso all'esecuzione immediata (artt. 52 e 59, lett. o) Codice del consumo, direttiva 2019/770); **se è lecito perdere i crediti cancellando l'account** e la clausola sulle prime 6 ore (clausole vessatorie, artt. 33 ss.); rimborso del saldo se il servizio chiude; conservazione a fini contabili (il venditore verso l'utente è lo store); se le Linee guida, che vietano le "vendite tramite eventi senza autorizzazione", e i Termini, che vietano l'uso commerciale, vanno riscritti ora che un'attività può pagare per promuovere i suoi eventi; art. 26 DSA; accessibilità (European Accessibility Act per l'e-commerce).
15. **Assicurazione**: valutare una RC e una polizza cyber, dato che il servizio favorisce incontri di persona ed eventi.
16. **Notifiche push**: l'informativa le descrive come non ancora attive; aggiornare quando saranno attivate (Expo/APNs/FCM).
17. **Librerie native Android**: la build Android include librerie Maven (AndroidX, OkHttp, Fresco, SoLoader, fbjni, Kotlin, Glide…, quasi tutte Apache-2.0) che non sono pacchetti npm e non si possono elencare senza il progetto `android/` e l'SDK. Prima della pubblicazione su Google Play generarne l'elenco nella build EAS (per esempio con un config plugin che applica il plugin Gradle `com.google.android.gms.oss-licenses-plugin` o `com.jaredsburrows.license`) e aggiungerlo agli avvisi. Su iOS non ci sono pod esterni a npm (`ios/Podfile.lock`).
18. **Attribuzione della mappa solo nella pagina delle licenze**: per scelta di prodotto la mappa non mostra la scritta "© OpenStreetMap". La Attribution Guideline della OSMF (2021) prevede per le mappe interattive l'attribuzione in un angolo della mappa, oppure su uno splash screen o pop-up all'avvio, che può sparire dopo 5 secondi o alla prima interazione; per "Computer games and simulations" ammette anche la pagina dei crediti o un menu. L'app (mappa 3D in stile videogioco) è stata ricondotta a quest'ultimo caso: Settings → Licenses, con link a openstreetmap.org/copyright. Valutare se basta; l'alternativa più sicura e con frizione minima è la scritta sulla mappa che sparisce da sola dopo 5 secondi all'apertura. CC BY 4.0 (OpenMapTiles, Open-Meteo) ammette l'attribuzione "in qualsiasi modo ragionevole" per il mezzo usato.

## Checklist di pubblicazione

- [ ] Completare i segnaposto e far firmare la DPIA (con parere del DPO).
- [ ] Pubblicare informativa, Termini e pagina di cancellazione su un sito; inserire gli URL negli store.
- [ ] Attivare gli indirizzi email (privacy, supporto, legal, autorità) e il presidio della moderazione.
- [ ] Firmare i DPA con i fornitori; verificare le regioni dei dati.
- [ ] Disattivare `TRUST_UNVERIFIED_TOKENS` in produzione; HTTPS ovunque; segreti `AVATAR_BAKE_SECRET` impostati.
- [ ] Aggiungere Sign in with Apple.
- [ ] Rivedere il catalogo degli avatar (punto 10).
- [ ] Compilare le etichette privacy degli store con `it/compliance/etichette-privacy-store.md`.
- [ ] Rigenerare `node scripts/legal.mjs` e ricontrollare dopo ogni aggiornamento delle dipendenze.
