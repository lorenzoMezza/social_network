# Procedura di gestione delle violazioni dei dati personali (artt. 33–34 GDPR)

Versione 1.0 · [DATA] · Referente: [NOME, telefono] · DPO: [NOME]

## 1. Che cos'è una violazione

Qualsiasi violazione della sicurezza che comporta, accidentalmente o illecitamente, la distruzione, perdita, modifica, divulgazione non autorizzata o accesso ai dati personali: riservatezza (es. accesso ai messaggi), integrità (es. profili alterati), disponibilità (es. perdita dell'archivio senza backup).

## 2. Passi

| Tempo | Azione | Chi |
|---|---|---|
| Subito | Chiunque se ne accorga avvisa il referente. Contenere: revocare credenziali, isolare sistemi, ruotare chiavi (incluse quelle di firma degli upload e la chiave del punto d'area, `AREA_HMAC_KEY`, che in produzione è fissa: va cambiata a mano, e i punti d'area di chi è in modalità approssimata cambiano una volta) | Chi rileva, tecnico |
| Entro 24 h | Valutare: dati e interessati coinvolti, numero, gravità, probabilità di rischio. Usare la tabella al punto 3 | Referente + DPO |
| **Entro 72 h** dalla conoscenza | **Notificare al Garante** (servizio online sul sito del Garante) se la violazione presenta un rischio per i diritti e le libertà. Se non si hanno tutte le informazioni, notificare per fasi | Titolare |
| Senza ingiustificato ritardo | **Comunicare agli interessati** se il rischio è elevato (art. 34), in linguaggio semplice: cosa è successo, conseguenze probabili, misure adottate, cosa possono fare, contatti | Titolare |
| Sempre | Annotare nel **registro delle violazioni** (anche quelle non notificate), con motivazione | Referente |
| Dopo | Analisi delle cause, correzioni, aggiornamento della DPIA | Tecnico + DPO |

Se la violazione riguarda un responsabile (es. hosting, Logto), il contratto ex art. 28 deve obbligarlo ad avvisarci senza ingiustificato ritardo.

## 3. Valutazione del rischio (indicativa)

| Dati coinvolti | Rischio tipico |
|---|---|
| Messaggi privati, collegamenti, luoghi d'incontro | Elevato: comunicare agli interessati |
| Email + identificativi | Medio: notificare; comunicare se combinati con altro |
| Dati pubblici del profilo | Basso |
| Posizione | In memoria per 45 s: un accesso al server in esecuzione espone solo le posizioni del momento; nessuna cronologia nei backup |

## 4. Registro delle violazioni (modello)

| Data scoperta | Data violazione | Descrizione | Dati e interessati (n.) | Conseguenze | Misure | Notifica Garante (data/n.) | Comunicazione interessati | Motivazione se non notificata |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
