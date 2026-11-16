# Etichette privacy degli store

Risposte suggerite per **Apple App Privacy** (App Store Connect) e **Google Play Data safety**, coerenti con il codice e con l'informativa. Versione 1.0 · [DATA]. Da ricontrollare a ogni rilascio che aggiunge SDK o dati.

## Apple — App Privacy

Tracciamento (ATT): **No**. L'app non traccia gli utenti tra app e siti di altre aziende; nessun SDK pubblicitario o di analisi.

| Tipo di dato (Apple) | Raccolto | Collegato all'identità | Usato per tracciare | Finalità |
|---|---|---|---|---|
| Contact Info → Email Address | Sì | Sì | No | App Functionality |
| Contact Info → Name | Sì | Sì | No | App Functionality |
| Location → Precise Location | Sì (solo se Visible) | Sì | No | App Functionality |
| Location → Coarse Location | Sì (Approximate; meteo) | Sì | No | App Functionality |
| User Content → Photos or Videos | Sì | Sì | No | App Functionality |
| User Content → Other User Content (bio, eventi, valutazioni) | Sì | Sì | No | App Functionality |
| User Content → Emails or Text Messages (messaggi in app) | Sì | Sì | No | App Functionality |
| User Content → Customer Support | Sì (se ci scrivono) | Sì | No | App Functionality |
| Identifiers → User ID | Sì | Sì | No | App Functionality |
| Identifiers → Device ID (token push, quando attivo) | Sì | Sì | No | App Functionality |
| Purchases → Purchase History (crediti e promozioni) | Sì | Sì | No | App Functionality |
| Other Data (avatar, stile del profilo, collegamenti) | Sì | Sì | No | App Functionality |
| Diagnostics | No (nessuno strumento di crash/analytics) | — | — | — |

Altri requisiti Apple: link all'informativa privacy in App Store Connect e nell'app (Settings → "Privacy policy"); cancellazione dell'account in app (Guideline 5.1.1(v)) ✔; stringhe di permesso in `app.json` (posizione solo "when in use", movimento, fotocamera, foto, calendario in sola scrittura) ✔; **l'app offre già "Continue with Google": su iOS la Guideline 4.8 impone di offrire anche "Sign in with Apple"** (o un altro login con le stesse garanzie: dati limitati a nome ed email, email nascondibile, nessun tracciamento) — da aggiungere in Logto prima della pubblicazione.

## Google Play — Data safety

- I dati sono cifrati in transito: **Sì** (HTTPS in produzione).
- L'utente può chiedere la cancellazione: **Sì** — in app e tramite [URL web di richiesta cancellazione, obbligatorio per Google Play].
- Dati condivisi con terze parti (nel senso di Google, esclusi i fornitori): **No**. Gli altri utenti vedono profilo e posizione per scelta dell'utente (non è "condivisione" ai sensi di Play; indicarlo comunque nella descrizione).

| Categoria (Google) | Raccolto | Facoltativo | Finalità |
|---|---|---|---|
| Posizione → approssimativa | Sì | Sì | Funzionalità app |
| Posizione → precisa | Sì | Sì | Funzionalità app |
| Informazioni personali → Nome, Email, ID utente | Sì | No (email, ID), Sì (nome visualizzato) | Gestione account, funzionalità |
| Foto e video → Foto | Sì | Sì | Funzionalità app |
| Messaggi → Altri messaggi in-app | Sì | Sì | Funzionalità app |
| Contenuti generati dagli utenti → Altri | Sì | Sì | Funzionalità app |
| ID dispositivo o altri ID (token push) | Quando attivo | Sì | Funzionalità app |
| Informazioni finanziarie → Cronologia acquisti (crediti e promozioni; mai carte o conti) | Sì | Sì | Funzionalità app |
| Attività nelle app, Info e prestazioni app, Cronologia web, Salute, Contatti, Audio, File, Calendario | **No** (il calendario è solo in scrittura sul dispositivo, i dati non lasciano il dispositivo) | — | — |

Permessi Android da dichiarare coerentemente: posizione (solo in primo piano), fotocamera, lettura immagini selezionate, calendario (scrittura), sensori di attività fisica se richiesti da `expo-sensors` per il contapassi [verificare in `android/` generato].
