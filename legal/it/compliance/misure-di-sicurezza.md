# Misure tecniche e organizzative (art. 32 GDPR)

Versione 1.0 · [DATA]. Ricavate dal codice del repository; le voci "produzione" vanno verificate sull'infrastruttura reale.

## Riservatezza e accesso

- **Autenticazione**: OpenID Connect con Logto; il backend verifica firma e scadenza dei token JWT (JWKS). L'accettazione di token non verificati esiste solo come opzione di sviluppo (`TRUST_UNVERIFIED_TOKENS`) e **deve essere disattivata in produzione**; anche in sviluppo i token scaduti o malformati sono rifiutati (test `tests/test_security.py`).
- **Autorizzazione**: ogni risorsa verifica proprietà e appartenenza (chat solo ai membri, eventi modificabili solo dall'organizzatore, foto rimovibili solo da autore o organizzatore, blocchi reciproci). Test automatici.
- **Sessione sul dispositivo**: token nell'archivio sicuro del sistema (Keychain / Keystore via SDK Logto). Al logout i dati dell'account salvati sul dispositivo vengono rimossi (`src/lib/accountStorage.js`).
- **Cifratura in transito**: HTTPS/WSS obbligatori in produzione [da configurare: TLS 1.2+, HSTS].
- **Cifratura a riposo**: [da garantire con l'hosting: disco e backup cifrati].
- **Accessi del personale**: [principio del minimo privilegio, autenticazione a più fattori, registro degli accessi amministrativi].

## Minimizzazione e privacy by design

- Posizione solo in memoria, 45 s, mai su disco né nei backup; avvio sempre Invisible.
- Modalità Approximate su griglia con scostamento segreto (HMAC) e controllo del raggio sul punto mostrato: resiste a media e trilaterazione (`tests/test_area.py`).
- Nessuna distanza esatta inviata ai client.
- Immagini ricodificate lato server: metadati EXIF (compreso il GPS) rimossi; dimensioni limitate (60 milioni di pixel, protezione dalle "decompression bomb").
- File cancellati dal disco quando sostituiti o rimossi; cancellazione dell'account a cascata (test).
- Meteo con coordinate arrotondate (~1 km); sensori di movimento elaborati solo sul dispositivo.
- Nessun SDK di analisi, pubblicità o tracciamento.

## Integrità e resilienza

- **Limiti contro gli abusi**: frequenza per utente e azione (messaggi, chat, eventi, upload, segnalazioni, collegamenti, esportazioni); budget di frame sul WebSocket (10/s, raffiche di 30, chiusura 1008); corpo JSON ≤ 256 KB; frame ≤ 64 KB; upload con dimensione dichiarata e verificata (413).
- **Upload**: URL firmati e a scadenza, tipo e dimensione verificati, file non usati cancellati entro 1 ora, originali cancellati appena elaborati; formati ammessi solo JPEG, PNG, HEIC, WebP.
- **Errori**: risposte generiche senza dettagli interni (500 `internal`).
- **WebView**: la mappa e il viewer avatar non possono navigare fuori dalla propria pagina locale né aprire finestre (`src/lib/localPageOnly.js`).
- **Link esterni**: solo http/https aperti dall'app (`safeWebLink`).
- **Esportazione**: link monouso, 10 minuti, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
- **Baker degli avatar**: accetta richieste solo dal backend (loopback o segreto condiviso), corpo ≤ 16 KB, coda limitata (503), file con nome a hash e nessun path traversal.

## Disponibilità

- [Backup giornalieri cifrati, conservati 30 giorni, prova di ripristino trimestrale].
- [Monitoraggio e allarmi].

## Organizzative

- [Nomina e istruzioni scritte agli autorizzati (art. 29 GDPR, art. 2-quaterdecies Codice Privacy)].
- [Formazione su privacy e moderazione].
- Procedure: diritti degli interessati, data breach, moderazione (documenti in questa cartella).
- [Dipendenze aggiornate; `npm audit` e controlli Python periodici; le vulnerabilità note residue delle dipendenze sono elencate nel README tecnico].
- Revisione di queste misure ogni 12 mesi.
