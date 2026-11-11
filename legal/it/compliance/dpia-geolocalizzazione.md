# Valutazione d'impatto sulla protezione dei dati (DPIA)

Trattamento: condivisione della posizione tra utenti vicini e funzioni sociali di [NOME APP]
Versione 1.0 · [DATA] · Redatta da: [NOME] · Parere del DPO: [DA ACQUISIRE] · Revisione: ogni 12 mesi o a ogni modifica rilevante

> Bozza preparata sulla base del codice dell'app (repository) e da sottoporre al legale e al DPO. Le parti tra parentesi quadre sono da completare.

## 1. Perché è necessaria

La DPIA è obbligatoria (art. 35 GDPR) perché il trattamento soddisfa più criteri delle Linee guida WP248 rev.01 e rientra nell'elenco del Garante (provvedimento n. 467 dell'11 ottobre 2018, allegato 1):

- trattamento di **dati di geolocalizzazione** in modo sistematico (elenco Garante, punto 6; WP248: monitoraggio sistematico);
- **uso innovativo di tecnologie** (mappa 3D in tempo reale con avatar, fusione sensori);
- dati di **interessati potenzialmente vulnerabili** se l'app venisse usata da minori nonostante il limite di 18 anni;
- **larga scala** potenziale (numero di utenti e area geografica non limitati);
- trattamento che può **impedire o condizionare** l'esercizio di diritti o la fruizione di servizi solo indirettamente — non applicabile.

## 2. Descrizione sistematica

### 2.1 Finalità

Mostrare all'utente le persone e gli eventi vicini su una mappa, permettergli di farsi vedere (o no) e di interagire (gesti, messaggi, collegamenti di persona, eventi).

### 2.2 Dati e flussi (dal codice)

| Flusso | Dati | Dove | Conservazione |
|---|---|---|---|
| GPS e sensori → app | posizione, precisione, accelerometro, giroscopio, bussola | solo dispositivo (fusione Kalman `src/features/map/motion`) | non salvati |
| App → server (frame WebSocket `presence`) | modo, lat/lon, precisione, direzione, velocità, "in movimento" | memoria del server (`realtime.py`, struttura `presences`) | ultima posizione, 45 s dall'ultimo aggiornamento; mai su disco né nei backup |
| Server → altri utenti | Visible: posizione precisa; Approximate: punto d'area; mai la distanza esatta | WebSocket | non conservati dal server |
| Collegamenti di persona (codice QR) | data, luogo generico | archivio del server | finché esiste il collegamento |
| App → Open-Meteo | coordinate arrotondate a 2 decimali (~1 km), IP | terza parte | secondo Open-Meteo |
| App → server delle tile (`tile-provider/`, nostro) | IP, tile richieste (zona visualizzata) | nostro server / CDN | [DA DEFINIRE: log del server o della CDN delle tile] |
| Eventi | luogo scelto dall'organizzatore | archivio del server | fino a cancellazione |

### 2.3 Interessati

Utenti maggiorenni; terzi ritratti nelle foto degli album degli eventi.

### 2.4 Asset

App React Native (Expo), WebView della mappa (three.js), backend [hosting], fornitore di autenticazione Logto, [CDN degli asset].

## 3. Necessità e proporzionalità

| Principio | Come è rispettato |
|---|---|
| Liceità (art. 6) | Condivisione della posizione: consenso specifico e informato (dialogo prima della prima attivazione, registrato con versione del testo: `PUT /me/consents/location-sharing`); revocabile con un tocco (Invisible). Funzioni sociali: contratto. Sicurezza: legittimo interesse (vedi LIA). |
| Limitazione della finalità | La posizione serve solo a mostrare l'utente ai vicini e a decidere chi è nel raggio, e un punto arrotondato a ~100 m a trovare gli eventi vicini, compresi quelli sponsorizzati, scelti solo per distanza. Nessuna profilazione, pubblicità mirata o vendita. |
| Minimizzazione | Solo l'ultima posizione, in memoria; raggio limitato a 1 km; modalità Approximate senza direzione né velocità; meteo con coordinate a ~1 km; sensori elaborati solo sul dispositivo; nessuna posizione in background; immagini ricodificate senza metadati EXIF (test `test_uploaded_pictures_lose_their_metadata`). |
| Esattezza | Fusione GPS/sensori sul dispositivo; l'utente vede ciò che vedono gli altri. |
| Limitazione della conservazione | Vedi `conservazione-dati.md`. Posizione: 45 s. |
| Integrità e riservatezza | Vedi `misure-di-sicurezza.md`. |
| Diritti | Accesso/portabilità (esportazione JSON con link monouso), cancellazione completa in app (test `test_delete_account_removes_everything`), rettifica in app, opposizione via email. |
| Privacy by default (art. 25) | L'app si apre sempre in Invisible (impostazione predefinita `mapStartInvisible: true`): la posizione viene condivisa solo dopo una scelta attiva in quella sessione. L'utente può decidere di riprendere l'ultima modalità scelta disattivando "Invisible when the app opens". |

## 4. Rischi per i diritti e le libertà

Scala: probabilità e gravità 1 (trascurabile) – 4 (massima). Il rischio residuo è valutato dopo le misure.

| # | Rischio | Origine | Prob. | Grav. | Misure | Residuo |
|---|---|---|---|---|---|---|
| R1 | **Stalking / pedinamento**: un malintenzionato segue una persona tramite la mappa | utente | 3 | 4 | Raggio 1 km; visibilità reciproca (chi è Invisible non vede nessuno); blocco che rende invisibili a vicenda; modalità Approximate; nessuna cronologia; nessuna distanza esatta; segnalazioni con revisione umana; Linee guida; limite d'età | Medio |
| R2 | **Trilaterazione** della posizione di chi è Approximate (spostarsi e osservare quando appare/scompare, o mediare i punti) | utente | 2 | 4 | Punto d'area legato a una griglia di 300 m con scostamento segreto (HMAC con chiave del server) stabile per persona/cella/giorno; ingresso nel raggio calcolato dal punto d'area; nessuna distanza inviata (test `tests/test_area.py`) | Basso |
| R3 | **Inferenza della residenza** (dove una persona sta di notte) | utente o violazione | 2 | 3 | Nessuna cronologia lato server; la posizione resta in memoria 45 s; ogni apertura dell'app parte da Invisible | Basso |
| R4 | **Uso da parte di minori** e adescamento | utente | 2 | 4 | Limite 18+ nei Termini; segnalazione "minor"; [DA VALUTARE: dichiarazione dell'età all'iscrizione e/o verifica — vedi README punto aperto 3] | Medio |
| R5 | **Violazione dei dati** (accesso non autorizzato ai messaggi, non cifrati end-to-end) | attaccante | 2 | 3 | TLS, token verificati, accessi limitati, limiti di frequenza, cifratura a riposo [del fornitore di hosting], posizione mai su disco; procedura data breach | Medio-basso |
| R6 | **Foto di terzi** senza consenso negli album | utente | 3 | 2 | Obbligo di consenso nei Termini; segnalazione "I'm in it and don't want it shared"; rimozione da autore o organizzatore; file cancellati dal disco | Basso |
| R7 | **Esposizione a terze parti** (coordinate a Open-Meteo) | terze parti | 3 | 1 | Coordinate meteo arrotondate a ~1 km; le tile della mappa arrivano solo dai nostri server (`tile-provider/`), nessun provider esterno | Basso |
| R8 | **Scraping** dei profili e delle presenze | attaccante | 2 | 2 | Accesso solo autenticato; dati visibili solo nel raggio; limiti di frequenza su socket (10 frame/s) e API | Basso |
| R9 | **Mancata cancellazione** effettiva | titolare | 1 | 3 | Cancellazione a cascata testata, inclusi file; [identità Logto da cancellare via Management API in produzione]; backup con rotazione | Basso |

## 5. Misure aggiuntive raccomandate prima del lancio

1. (Già in essere) Avvio in Invisible per impostazione predefinita.
2. (Già in essere) Tile della mappa servite solo da infrastruttura propria (`tile-provider/`).
3. Dichiarazione dell'età (18+) al primo accesso, con testo breve e senza ulteriori passaggi, coerente con la scelta di UX semplice; valutare strumenti di verifica dell'età in funzione dell'evoluzione normativa (AGCOM, linee guida della Commissione sull'art. 28 DSA).
4. Cancellazione dell'identità presso Logto via Management API nella procedura di cancellazione.
5. Registro tecnico (log) con conservazione di 30 giorni e accesso limitato.
6. Formazione dei moderatori e tempi di risposta per le segnalazioni di pericolo (R1, R4).

## 6. Conclusione

[DA COMPILARE dopo la revisione] Con le misure in essere e quelle raccomandate, il rischio residuo è ritenuto [accettabile / non accettabile]. Se il rischio residuo restasse elevato è necessaria la consultazione preventiva del Garante (art. 36 GDPR).

Firma del titolare: ____________ · Parere del DPO: ____________
