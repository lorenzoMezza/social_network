# Fornitori, responsabili del trattamento e trasferimenti extra SEE

Versione 1.0 · [DATA]. Ricavato dal codice: ogni host contattato dall'app o dal backend è elencato qui. Prima del lancio, per ogni responsabile: contratto ex art. 28 (DPA) firmato, regione dei dati verificata, base del trasferimento documentata (Capo V GDPR) e, per gli USA senza DPF, valutazione d'impatto del trasferimento (TIA).

## Responsabili del trattamento (art. 28)

| Fornitore | Servizio | Dati | Paese / regione | Base del trasferimento | DPA | Stato |
|---|---|---|---|---|---|---|
| [HOSTING, es. provider UE] | Server API, archivio, file, backup | Tutti i dati del servizio | [UE consigliato] | Non necessario se UE | [ ] | Da scegliere |
| Logto (Silverhand Inc. — [verificare soggetto contraente]) | Autenticazione (OIDC), tenant `bl5ooc.logto.app` | Identificativo, email, metodo di accesso, IP e dispositivo al momento dell'accesso | [Verificare regione del tenant: EU / US] | [Se US: DPF o SCC + TIA] | [ ] | Da verificare |
| Expo (650 Industries, Inc.) | Invio notifiche push (quando attivate) | Token push, contenuto delle notifiche | USA | [DPF se certificata, altrimenti SCC] | [ ] | Non ancora attivo |
| [CDN asset avatar] | File degli avatar e modelli da mappa (`/v1/files`, `/v1/map-avatars`) | IP di chi scarica; nessun dato personale nei file (i modelli da mappa sono identificati da un hash del look, non dall'utente) | [ ] | [ ] | [ ] | Da scegliere |
| [Email / helpdesk] | Assistenza e richieste privacy | Email, contenuto | [ ] | [ ] | [ ] | Da scegliere |

## Titolari autonomi contattati dal dispositivo dell'utente

Ricevono l'IP dell'utente e quanto indicato; non agiscono per nostro conto. Indicati nell'informativa (sezione 6).

| Servizio | Cosa ricevono | Nota |
|---|---|---|
| Open-Meteo (api.open-meteo.com) | IP, coordinate arrotondate a 2 decimali (~1 km) | Già minimizzato nel codice (`weather.js`). Per uso commerciale verificare i termini di Open-Meteo (piano a pagamento `customer-api`) |
| Apple (APNs), Google (FCM) | Token e notifiche, tramite Expo | Quando le notifiche saranno attive |
| Apple App Store, Google Play | Dati di download e acquisto. Il nostro server li interroga per verificare ogni acquisto (Play Developer API, certificati Apple) e riceve da loro le notifiche di rimborso | Titolari autonomi secondo i propri termini; sono il venditore verso l'utente |

## Host presenti nel codice ma non usati

- `api.mapbox.com`: supportato dalla libreria della mappa (three-geo-play) ma non configurato. Se fosse attivato servirebbe aggiornare informativa e questo elenco.
- `picsum.photos`: solo nei dati dimostrativi del backend di sviluppo (`seed.py`). Da escludere dalla produzione.

## Sub-responsabili

Chiedere a ciascun responsabile l'elenco dei sub-responsabili e il meccanismo di notifica delle modifiche (art. 28, par. 2 e 4).
