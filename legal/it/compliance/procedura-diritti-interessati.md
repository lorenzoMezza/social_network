# Procedura per l'esercizio dei diritti degli interessati (artt. 12–22 GDPR)

Versione 1.0 · [DATA] · Responsabile interno: [NOME] · Canale: [privacy@DOMINIO]

## Canali

| Diritto | Self-service in app | Su richiesta |
|---|---|---|
| Accesso (art. 15) e portabilità (art. 20) | Settings → "Download my data": link monouso valido 10 minuti a un file JSON (`POST /v1/me/export`) | Email: si genera lo stesso file e lo si invia in modo sicuro, dopo verifica dell'identità |
| Rettifica (art. 16) | Modifica del profilo | Email |
| Cancellazione (art. 17) | Settings → "Delete account" (`DELETE /v1/me`, a cascata) | Email; **Google Play richiede anche una pagina web per chiedere la cancellazione senza l'app**: [URL DA PUBBLICARE] |
| Limitazione (art. 18) | — | Email: sospensione manuale del trattamento contestato |
| Opposizione (art. 21) | — | Email: valutazione sulla base della LIA |
| Revoca del consenso (art. 7) | Modalità Invisible | — |
| Persone ritratte nelle foto (non utenti) | Segnalazione "I'm in it and don't want it shared" | Email |

## Passi per una richiesta via email

1. **Registrare** la richiesta (data di ricezione, richiedente, diritto, canale) nel registro delle richieste.
2. **Verificare l'identità** in modo proporzionato: rispondere dall'indirizzo email dell'account, oppure chiedere di confermare dall'app. Non chiedere documenti se non strettamente necessario.
3. **Rispondere entro un mese** dalla ricezione. Proroga di due mesi solo per richieste complesse o numerose, comunicata entro il primo mese con i motivi (art. 12, par. 3).
4. **Gratuità**: si può addebitare un contributo o rifiutare solo per richieste manifestamente infondate o eccessive, motivando (art. 12, par. 5).
5. **Diritti di terzi**: nell'esportazione gli altri utenti compaiono solo con identificativo, nome e username; i messaggi ricevuti non sono inclusi (sono dati anche dei mittenti). Valutare caso per caso (art. 15, par. 4).
6. **Rifiuto o ritardo**: comunicare i motivi e la possibilità di reclamo al Garante e di ricorso giurisdizionale.
7. **Comunicare ai destinatari** la rettifica, cancellazione o limitazione (art. 19): fornitori (es. Logto) ed eventuali altri.
8. **Archiviare** la prova dell'adempimento per [5 anni].

## Modello di risposta (cancellazione)

> Gentile [nome], abbiamo eliminato il tuo account e i dati collegati il [data]: profilo, immagini, avatar, collegamenti, blocchi, eventi organizzati con foto e chat, foto e messaggi pubblicati, valutazioni, eventi salvati, saldo dei crediti e movimenti; i gruppi che avevi creato sono passati ad altri membri, senza i tuoi messaggi. Conserviamo per 12 mesi, per la sicurezza degli altri utenti, le eventuali segnalazioni che ti riguardano; le segnalazioni che hai inviato restano senza la tua identità. I backup vengono sovrascritti entro [30 giorni]. Se non sei soddisfatto puoi proporre reclamo al Garante per la protezione dei dati personali (www.garanteprivacy.it).
