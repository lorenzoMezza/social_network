# Moderazione dei contenuti e obblighi del Digital Services Act

Regolamento (UE) 2022/2065 ("DSA") · Versione 1.0 · [DATA]

## 1. Qualificazione del servizio

L'app memorizza informazioni fornite dagli utenti (profili, eventi, foto, messaggi) e ne diffonde una parte al pubblico degli utenti (profili ed eventi visibili a chi è vicino): è un servizio di memorizzazione di informazioni (hosting, art. 6) e verosimilmente una **piattaforma online** (art. 3, lett. i). Le chat private non sono "diffusione al pubblico".

Se il titolare è una **micro o piccola impresa** (Racc. 2003/361/CE: < 50 dipendenti e fatturato o bilancio ≤ 10 milioni di euro), è esente dagli obblighi della Sezione 3 (artt. 19 e seguenti: reclami interni, risoluzione extragiudiziale, segnalatori attendibili, ecc.), salvo l'art. 24, par. 3. Si raccomanda comunque di applicare reclamo interno e motivazioni come buona pratica. [DA VERIFICARE con il legale: dimensione dell'impresa e numero di destinatari attivi.]

## 2. Obblighi e attuazione

| Articolo | Obbligo | Attuazione | Stato |
|---|---|---|---|
| 11 | Punto di contatto per le autorità | [authorities@DOMINIO], lingue IT/EN, pubblicato nei Termini | Da attivare l'indirizzo |
| 12 | Punto di contatto per gli utenti | [legal@DOMINIO], non solo strumenti automatici | Da attivare |
| 13 | Rappresentante legale | Solo se stabiliti fuori dall'UE | Non applicabile se in Italia |
| 14 | Termini con le restrizioni, la moderazione e il reclamo interno | `legal/en/terms-of-use.md` §7–8, Linee guida | Fatto (bozza) |
| 15 | Relazione annuale di trasparenza | Esentate micro e piccole imprese (art. 15, par. 2) | [Verificare] |
| 16 | Meccanismo di segnalazione per chiunque | In app: segnalazione di utente, evento, foto, messaggio (`POST /v1/reports`); fuori app: [legal@DOMINIO] con i contenuti dell'art. 16, par. 2; **conferma di ricezione** al segnalante e comunicazione della decisione | In app attuato; email da attivare; conferma e notifica della decisione **da attuare** (oggi l'app mostra "Thanks for telling us") |
| 17 | Motivazione delle restrizioni | Modello sotto (§4); da inviare al momento della decisione | **Da attuare** nello strumento di moderazione |
| 18 | Notifica di sospetti reati gravi | Procedura: pericolo per la vita o la sicurezza → autorità competenti (in Italia Polizia di Stato / Polizia Postale) | Da formalizzare |
| 20 | Reclamo interno (6 mesi, gratuito, revisione umana) | Risposta alla motivazione o [legal@DOMINIO]; revisore diverso | Da attuare (se non esentati: obbligatorio) |
| 23 | Misure contro gli abusi | Sospensione temporanea per contenuti manifestamente illegali o segnalazioni infondate, previo avvertimento | Nei Termini; strumento da attuare |
| 24.3 / 24.2 | Numero medio mensile di destinatari attivi | Pubblicare su richiesta / ogni 6 mesi | Da predisporre il conteggio |
| 25 | No dark pattern | Interfaccia semplice, nessuna scelta preimpostata a danno dell'utente (avvio in Invisible) | Rispettato |
| 26 | Trasparenza della pubblicità | Gli eventi promossi sono marcati "Sponsored" nell'elenco, sulla scheda della mappa e nella pagina, con chi li paga (l'organizzatore) e fin dove sono mostrati; scelti solo in base alla distanza, nessuna profilazione. [Da verificare: se la Sezione 3 non si applica, è comunque buona pratica] | Attuato |
| 28 | Tutela dei minori | Servizio 18+; annunci solo come eventi sponsorizzati per distanza, nessuna profilazione; vedi DPIA R4 | Da valutare la verifica dell'età |

## 3. Flusso di moderazione

1. **Ricezione**: segnalazione in app o email. Registrare: ID, data, segnalante (se presente), contenuto, motivi.
2. **Priorità**: minacce, pericolo per la vita, minori, materiale pedopornografico → immediata (entro [1 h] in orario operativo); molestie, odio, contenuti sessuali → entro [24 h]; spam, altro → entro [72 h].
3. **Valutazione umana** rispetto a legge e Linee guida. Documentare la base (illegalità o violazione dei Termini).
4. **Decisione**: nessuna azione / rimozione del contenuto / limitazione / sospensione temporanea / chiusura dell'account. Proporzionata e coerente.
5. **Comunicazioni**: al segnalante (esito) e all'interessato (motivazione, §4). Il segnalante resta riservato.
6. **Reclamo**: riesame da parte di un'altra persona; possibile ripristino.
7. **Conservazione**: segnalazioni 12 mesi (attuato nel backend).
8. **Materiale pedopornografico**: non scaricare né conservare oltre lo stretto necessario; segnalare alla Polizia Postale (Centro nazionale per il contrasto della pedopornografia online); conservare solo quanto richiesto dalle autorità.

## 4. Modello di motivazione (art. 17)

> **Decisione su un tuo contenuto / account** — [data]
> - Cosa abbiamo deciso: [rimozione del contenuto X / sospensione dell'account fino al … / chiusura dell'account]; ambito e durata.
> - Perché: [il contenuto viola la regola "…" delle Linee guida / è illegale ai sensi di …: spiegazione].
> - Fatti e circostanze: [segnalazione di un utente / nostra verifica], [data].
> - Uso di strumenti automatici: [nessuno / quali].
> - Come contestare: rispondi a questo messaggio o scrivi a [legal@DOMINIO] entro 6 mesi; una persona diversa riesaminerà la decisione. Puoi anche rivolgerti a un organismo di risoluzione extragiudiziale certificato (art. 21 DSA) o all'autorità giudiziaria.

## 5. Requisiti degli store (contenuti generati dagli utenti)

Apple App Store Review Guideline 1.2 e Google Play (User Generated Content) richiedono: filtro dei contenuti inaccettabili, segnalazione con risposta tempestiva, blocco degli utenti, contatti pubblicati, Termini accettati dagli utenti. In app: segnalazione e blocco presenti; accettazione dei Termini all'accesso (schermata di accesso); contatti nei Termini.
