# Politica di conservazione dei dati

Versione 1.0 · [DATA]. Ogni riga indica la durata e **lo stato di attuazione nel codice**, perché l'informativa descriva solo ciò che avviene davvero.

| # | Dati | Durata | Attuazione | Dove nel codice |
|---|---|---|---|---|
| C1 | Posizione sulla mappa | Solo l'ultima, in memoria, 45 s dall'ultimo aggiornamento se la connessione si perde; eliminata 1 minuto dopo aver lasciato la mappa, subito passando a Invisible o con l'app in background o chiusa | **Attuata** | `backend/app/realtime.py` (`TTL_S`, `presences` mai persistito) |
| C1b | Punto approssimativo anti-falsificazione (arrotondato a ~1 km) | Solo l'ultimo, in memoria, 16 h al massimo; eliminato con l'account. Da valutare con il legale: base giuridica (legittimo interesse, sicurezza) | **Attuata** | `backend/app/position_guard.py` |
| C1c | Punto di ricerca eventi (arrotondato a ~100 m) | In memoria finché l'app è connessa, 10 minuti dopo l'ultima ricerca se non lo è; eliminato con l'account | **Attuata** | `backend/app/domain.py` (`event_watch`) |
| C2 | Punto d'area (Approximate) | In memoria con la presenza | **Attuata** | `realtime._area_point` |
| C3 | Account, profilo, avatar, impostazioni, collegamenti, blocchi | Fino a cancellazione dell'account | **Attuata** (cancellazione in app) | `backend/app/privacy.py` `erase_user` |
| C3-bis | Account inattivi | [24 mesi senza accesso, previo avviso di 30 giorni] | **Da attuare** (job del janitor + email/notifica) | — |
| C4 | Messaggi di chat dirette e di gruppo | Finché esiste la chat; con l'account dell'autore | **Attuata** la cancellazione con l'account, e del singolo messaggio da parte del suo autore o di chi gestisce la chat: il testo sparisce subito dal server | `privacy.erase_user` |
| C4-bis | Chat degli eventi | 30 giorni dopo la fine (o l'annullamento) dell'evento | **Attuata** | `privacy.retention_sweep` (test `test_retention_policy`) |
| C5 | Eventi, copertine, album | Fino a cancellazione da parte dell'organizzatore o dell'account | **Attuata** (file cancellati dal disco) | `privacy.erase_user`, `media.discard` |
| C5-bis | Eventi conclusi o annullati | 12 mesi dopo la fine, poi cancellati con album (file compresi) e chat | **Attuata** | `privacy.retention_sweep` |
| C6 | Segnalazioni, con una copia di ciò che è stato segnalato com'era in quel momento | 12 mesi dall'invio; oltre solo se estratte per contenziosi o richieste delle autorità (fuori dal sistema, con registro) | **Attuata** (anche la rimozione del segnalante alla sua cancellazione) | `privacy.retention_sweep`, `privacy.erase_user` |
| C7 | Registri tecnici (IP, richieste) | [30 giorni] | **Da configurare** sull'infrastruttura di produzione (in sviluppo uvicorn scrive su console) | — |
| C8 | Contatori anti-abuso | Minuti | **Attuata** | `backend/app/limits.py` `sweep` |
| C9 | Link di esportazione | 10 minuti, monouso | **Attuata** | `privacy.export_ticket`, `redeem` |
| C10 | Upload non utilizzati | 1 ora (15 minuti se il file non è mai arrivato); l'originale di un upload usato è cancellato appena elaborato | **Attuata** | `backend/app/media.py`, `backend/app/janitor.py` |
| C11 | Immagini sostituite o rimosse | Cancellate subito | **Attuata** | `media.discard` (test `test_replaced_picture_leaves_no_file`) |
| C12 | Registro dei consensi | Con l'account (ultimi 50 per tipo) | **Attuata** | `routes/people.py` `record_consent` |
| C13 | Backup | [30 giorni, poi sovrascritti]; una cancellazione si estende ai backup alla loro scadenza | **Da definire** con l'hosting | — |
| C14 | Identità presso Logto | Cancellata con l'account | **Da attuare** in produzione (Management API) | — |
| C16 | Saldo, movimenti e promozioni | Fino a cancellazione dell'account; [da verificare se gli obblighi contabili impongono di più: il venditore verso l'utente è lo store] | **Attuata** la cancellazione con l'account | `privacy.erase_user`, `promotions.forget_user` |
| C16-bis | Identificativi degli acquisti già accreditati, senza account | [Da definire]: servono a non accreditare due volte lo stesso acquisto | **Attuata**, senza scadenza | `store.store_transactions` |
| C15 | Dati sul dispositivo | Sessione: fino al logout; cache tile: 30 giorni / 250 MB; cache dei file avatar (modelli del catalogo, nessun dato personale): 100 MB, i meno usati cancellati per primi; dati dell'account: rimossi al logout | **Attuata** | `src/lib/accountStorage.js`, `webview/shared/httpCache.js` |

Prima del lancio: attuare le righe "Da attuare" oppure adeguare l'informativa a ciò che avviene davvero.
