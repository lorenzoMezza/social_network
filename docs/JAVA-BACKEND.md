# Backend di produzione in Java: scheda tecnica

Requisiti e architettura del backend vero, scritto a mano in Java. `backend/app` (Python) resta
il banco di prova: serve a sviluppare l'app e dice come si deve comportare il server.
`API.md` resta il contratto con l'app; qui c'è come realizzarlo. Sostituisce una prima divisione in
quattro servizi.

**L'ordine delle priorità**: sicurezza, poi stabilità e assenza di bug, poi prestazioni. Tra due strade che reggono entrambe
vince quella più semplice da scrivere giusta.

**Come usarla**: `API.md` dice *cosa* risponde il server, e in caso di dubbio vince lui. Questa scheda dice *come*
farlo reggere. Il Python mostra il comportamento esatto (§17). Il §11 dice cosa serve per funzionare con l'app di
oggi, il §13 da dove partire e come collegare l'app, il §16 quali errori tipici di Java evitare e il codice già provato da cui
partire, il §21 come impostare JVM, qualità del codice e rilascio. I tre pezzi su cui si può sbagliare di più hanno una sezione
propria: **messaggi (§18), upload e immagini (§19), abusi e correttezza verso gli utenti (§20)**. Il §22 dice cosa è stato provato
davvero e cosa no.

Stato: proposta del 2026-11-04, quarta versione. Passa da Go a Java per scelta, e riscriverla ha trovato cinque errori del
progetto che valevano con qualsiasi linguaggio (§22). Controllata contro il codice dell'app e contro il Python, con prove vere delle
parti più rischiose, non contro un server Java completo, che non esiste ancora. Ricontrollata il 2026-11-10 contro l'app
com'è oggi (rotte chiamate, frame del socket, codici e stati che l'app distingue, richieste senza corpo, upload): le differenze trovate sono nel §11, nel §13 e nel
§19 ("Cosa fa l'app con un upload"). Riletta per intero il 2026-11-11 cercando errori di logica: trovati e corretti l'ordine del passo 3 degli upload (§19: senza, "un errore del server non consuma l'upload" e
"mai la rete dentro una transazione" non potevano valere insieme, e una richiesta morta a metà lasciava file pubblici orfani), la chiave di idempotenza cercata fuori dal lock (§7.3: due tentativi insieme passavano entrambi),
e tre forme che l'app controlla e che qui non erano scritte (§11: token di connessione, `mapAvatar`, documenti statici degli avatar al §9). I numeri di prestazioni sono ordini di
grandezza presi su un Mac (§4.4): le capacità vere si misurano sulla macchina vera (§12).

## 1. L'idea in breve

L'app è fatta di tanti gruppetti locali: chi è a Roma non genera lavoro per chi è a Milano.

1. **Ognuno ha il suo cerchio.** Ogni persona vede al massimo **25 persone**, scelte attorno a lei: prima
   le sue connessioni, poi le più vicine. Non esistono zone fisse nel comportamento dell'app, quindi
   nemmeno frontiere.
2. **Il servizio di presenza fa il matching**: tiene le posizioni in memoria, trova per ognuno i
   vicini, e da lì ogni aggiornamento viaggia solo sulle coppie già abbinate.
3. **Il costo è lineare.** Ognuno riceve al massimo 25 persone: il lavoro cresce con il numero di
   persone, non con il loro quadrato (§4.4).
4. **Una sola macchina per la presenza** regge molto a lungo, e senza partizione geografica non c'è
   nessuna frontiera nemmeno dentro il server.
5. **Un solo Postgres con PostGIS** per ciò che resta, un eseguibile Java con più ruoli (più un piccolo
   programma separato per le immagini), e i file su object storage senza costi di uscita. Niente Kubernetes, Kafka o microservizi all'inizio.

Costo stimato: circa **200 €/mese al lancio, 1.100 €/mese a 1 milione di utenti al giorno, 5-7.000
€/mese a 10 milioni** (§10).

## 2. Come funziona l'app, vista dal server

| Carico | Esempio | Natura | Dove sta |
|---|---|---|---|
| **Presenza** | chi vedo sulla mappa, gesti, annunci | caldissimo, locale, si può perdere | RAM |
| **Eventi** | lista vicina, pagina, partecipanti | molte letture, poche scritture, locale | Postgres + PostGIS + cache |
| **Chat** | messaggi, sondaggi, moderazione | scritture costanti, deve restare | Postgres |
| **Persone** | profilo, connessioni, blocchi, storia | letture brevi per chiave | Postgres + cache |
| **Denaro** | crediti, acquisti, promozioni | raro, non si può sbagliare mai | Postgres, transazioni |
| **File** | foto, avatar, tile | grossi, immutabili | object storage + CDN |

### Il carico reale generato dall'app

Dal comportamento del client (`nearbyPeople.js`): un frame al secondo in movimento, uno ogni 15 s
da fermo, solo sulla mappa e per 60 s dopo averla lasciata. Ipotesi da verificare coi dati veri: 8%
degli utenti del giorno connessi nel picco, metà sulla mappa, metà di questi non Invisible, 20% in
movimento.

| Utenti al giorno | Socket aperti | Condividono la posizione | Frame in ingresso | Banda in ingresso |
|---|---|---|---|---|
| 100.000 | 8.000 | 2.000 | ~500/s | 1 Mbit/s |
| 1.000.000 | 80.000 | 20.000 | ~5.000/s | 6 Mbit/s |
| 10.000.000 | 800.000 | 200.000 | ~50.000/s | 61 Mbit/s |

**Il problema non è l'ingresso, sono le folle in uscita.** Senza limiti, ogni persona che si muove va
mandata a tutti quelli che la vedono: in una piazza da N persone sono N² consegne. Con 50.000 persone a
un concerto farebbero 625 milioni di record al secondo. Il §4 lo risolve alla radice.

## 3. Requisiti

### Funzionali

Tutto `API.md`, comportamento compreso. In più, oggi mancanti e **necessari per il lancio**:

- notifiche push (messaggi, inviti a connettersi, cambi agli eventi), con effetto reale degli
  interruttori in Impostazioni;
- versione minima dell'app (`X-Client`, 426: l'app lo manda già e sa già chiedere di aggiornare);
- account dal token d'identità verificato (`X-Id-Token`: l'app lo manda già; `X-Profile-Hint` va ignorato in
  produzione) e ID pubblici `usr_…` slegati dal `sub` di Logto;
- pannello di moderazione: coda delle segnalazioni, rimozione di contenuti, sospensione di account
  (DSA, regole App Store e Google Play);
- cancellazione dell'identità su Logto (Management API).

### Non funzionali

| Requisito | Obiettivo |
|---|---|
| Letture REST | p95 < 150 ms al server |
| Scritture REST | p95 < 300 ms al server |
| Presenza, da un telefono all'altro | < 1 s |
| Apparizione delle persone all'apertura della mappa | < 2 s |
| Comparsa sulla mappa di chi arriva vicino | < 5 s |
| Sparizione con app in background | < 2 s (misurata oggi: 1 s) |
| Dati mobili sulla mappa | ≤ ~5 KB/s nel caso peggiore, ~1,2 KB/s tipici, prima della compressione (stima, §4.6) |
| Persone sulla mappa di un telefono | ≤ 25, prima le connessioni (§4.2, §4.6) |
| Socket per server | ≥ 50.000 (da verificare, §12) |
| Disponibilità | 99,9% |
| Perdita massima di dati (RPO) | ≤ 1 minuto |
| Ripristino (RTO) | ≤ 30 minuti |
| Crescita | da 1 a 3 server aggiungendo macchine, senza cambiare l'app |

### Sicurezza e privacy (non negoziabili)

- Ogni regola sta sul server, a ogni richiesta (`API.md`, Principi).
- **La posizione non tocca mai il disco**: né database, né log, né code persistenti.
- La posizione reale di chi è Approximate non arriva mai a nessun telefono (§4.5).
- Un bloccato non riceve mai niente dell'altro: lo decide il server al momento del matching.
- Le regole di visibilità (`sees_story`) valgono su tutti i percorsi.
- Hosting nell'UE. Conservazione come da `legal/it/compliance/conservazione-dati.md`.
- Log senza token, testi dei messaggi e coordinate. **Gli URL non si registrano mai con la loro query**: `GET /events?latitude&longitude`
  ha la posizione lì dentro, e un log di accesso la scriverebbe su disco. Vale per HAProxy, Jetty e ogni filtro (§9).
- Niente dump della memoria, core dump o swap: contengono posizioni, messaggi e token (§21).
- Dischi e backup cifrati (LUKS, `pgBackRest` con cifratura): i messaggi non sono cifrati end-to-end, perché
  la moderazione deve poterli leggere, e quindi vanno protetti sul server.
- Le minacce una per una, con cosa le ferma e cosa resta scoperto: §20.

## 4. Il cuore: la geospazialità

### 4.1 Tre problemi diversi, tre soluzioni diverse

| Problema | Domanda | Chi decide il raggio | Esempi | Soluzione |
|---|---|---|---|---|
| **Vicini in movimento** | chi vede chi, mentre tutti si muovono | la persona (1 km, 25 vicini) | mappa, annunci, gesti | matching in RAM (§4.3-4.7) |
| **Raggio inverso** | quali eventi mi raggiungono da dove sono | **l'evento** (100 m-10 km) | lista Nearby | PostGIS (§4.8) |
| **Controllo puntuale** | queste due cose sono vicine? | la regola | flash 500 m, connessione 100 m, 15 m tra eventi | §4.9 |

### 4.2 Perché al massimo 25 persone sulla mappa

Misurato con `make map-bench-people`: la pagina della mappa in Chrome su un Mac M5, tutte le persone
entro 40 m dal giocatore (il caso peggiore), looks tutti diversi fino a 178.

| Persone | Nell'inquadratura | Triangoli | CPU ms a frame | GPU ms (5×, carico da telefono) | Memoria GPU | Memoria JS |
|---|---|---|---|---|---|---|
| 0 | 0 | 96.000 | 1,3 | 4,2 | 16 MB | 19 MB |
| **25** | **22** | **234.000** | **2,0** | **6,0** | **50 MB** | **75 MB** |
| 50 | 39 | 344.000 | 2,5 | 6,9 | 58 MB | 91 MB |
| 100 | 73 | 563.000 | 2,6 | 9,8 | 119 MB | 172 MB |
| 200 | 154 | 1,08 M | 3,3 | 15,6 | 205 MB | 344 MB |
| 300 | 236 | 1,6 M | 3,1 | 24,2 | 308 MB | 381 MB |
| 500 | 398 | 2,6 M | 4,0 | **81,9** | 496 MB | 459 MB |
| 1000 | 781 | 5,1 M | 6,3 | **384** | 1016 MB | 980 MB |

**Come leggerla**: i tempi sono di un Mac, un telefono è più lento di diverse volte; conta come crescono. Con 25
persone la GPU fa 1,4 volte il lavoro della mappa vuota, con 34 MB di memoria GPU e 56 MB di JavaScript in più. A 50 fa
1,65 volte, a 100 2,3 volte, a 200 3,7 volte. **Oltre i 300 crolla**: tra 300 e 500 il frame peggiora di oltre 3 volte con
meno del doppio delle persone, e a 1000 si supera 1 GB tra GPU e JavaScript, dove una WebView rischia di essere uccisa dal
sistema.

**25 è il valore scelto** per dare margine ai telefoni meno recenti. **Non è provato su un telefono vero**, quindi va
confermato (§12). È un valore di configurazione del server (`MAX_SHOWN`), cambiabile senza aggiornare l'app, e l'app disegna
semplicemente chi il server le manda.

### 4.3 Il servizio di presenza: matching di persone vicine

```
 telefono ──frame──▶ GATEWAY ──▶ PRESENZA
                                  │ 1. aggiorna la posizione nell'indice
                                  │ 2. ogni 5 s, per ogni persona: chi sono i miei 25?
                                  │ 3. ogni 0,5 s: chi si è mosso, va a chi lo guarda
                                  ▼
                               GATEWAY ──▶ solo i telefoni interessati
```

La presenza tiene tre cose in memoria:

| Struttura | Contenuto | Uso |
|---|---|---|
| **Indici** (PH-Tree, tre: §4.5) | il punto di ogni persona | "chi ho vicino", solo per il matching |
| `watching[persona]` | i suoi fino a 25 vicini | sapere cosa ha sullo schermo |
| `watchers[persona]` | chi ha quella persona sullo schermo | consegnare i suoi aggiornamenti |

**La cosa importante**: l'indice serve poco. Un aggiornamento di posizione **non cerca niente**: legge
`watchers[persona]` e consegna. La ricerca dei vicini, l'operazione costosa, avviene solo ogni 5 s per
persona, o quando la persona si è spostata di 25 m, e all'ingresso sulla mappa.

Quando qualcuno arriva sulla mappa, il matching si fa subito sia per lui sia, a chi gli sta attorno,
come aggiunta. Così compare senza aspettare il giro dei 5 s di tutti gli altri.

**Quante persone guardano una persona** è limitato dalla geometria: chi ti ha tra i suoi 25 più vicini
ti sta vicino, e sul piano queste relazioni non possono concentrarsi tutte su di te. Misurato senza connessioni: **al
massimo 44 osservatori, sia con 1000 persone sia con 1 milione**. Quindi nessuno genera mai una valanga
di consegne, e il costo totale resta lineare. Le connessioni aggiungono osservatori oltre la geometria, ma sono persone
incontrate davvero: non è un numero che cresce con la folla.

### 4.4 Quanto costa

Simulazione completa di un secondo di carico (prototipo usa e getta, K = 25): 25% delle persone si muove, 1/5 ricalcola i vicini, ogni
movimento viene consegnato a chi guarda. Un solo core, Docker su un Mac, con il Mac impegnato anche in altro. **Il programma è in Go perché quello era il
linguaggio previsto, e questi numeri servono a capire come cresce il costo, non quanto regge il server**: lo stesso codice cambia di oltre 2 volte col
carico della macchina e col risparmio energetico.

| Persone sulla mappa | Core usato (Go) | Vicini calcolati/s | Consegne/s | Uscita con il JSON di oggi (190 byte) |
|---|---|---|---|---|
| 1.000, in 300 m | **0,2%** | 200 | 6.300 | 1,2 MB/s |
| 5.000, in 300 m | **1,2%** | 1.000 | 31.000 | 6 MB/s |
| 50.000, in 300 m (concerto) | **~16-18%** | 10.000 | 313.000 | 59 MB/s |
| 200.000, in una città | **~85-93%** | 40.000 | 1,25 M | 238 MB/s |
| 1.000.000, in una regione | **~540-940%** | 200.000 | 6,2 M | 1,2 GB/s |

**È lineare**: 50 volte più persone, circa 50 volte il lavoro. Con 50 persone invece di 25 il lavoro sarebbe circa 1,6 volte, e la banda il doppio.
Il codice Python attuale, quadratico, con 1000 persone non regge già il giro da 0,5 s.

**In Java, misurato il 2026-11-05 con il matching come è progettato** (prototipo usa e getta): un thread, tre indici sulla sfera, privacy, blocchi, connessioni, chi entra ed esce, JSON dei frame.
I frame arrivano a tempo reale con i tempi dell'app (20% in movimento, 20% Approximate). Docker su un Mac M5 a corrente, con la velocità del core stabile entro il 3% per tutte le prove. La rete, la lettura del JSON in arrivo, gesti e annunci **non** ci sono.

| Scenario | Persone sulla mappa | Thread della presenza | Posizione → frame pronto, p50 / p99 | Entrata → snapshot, p99 | Uscita (senza compressione) |
|---|---|---|---|---|---|
| Piazza (tutti in 300 m) | 40.000 | 37% di un core | 273 / 522 ms | 22 ms | 66.000 frame/s, 47 MB/s |
| | 80.000 | 63-69% | 291 / 534 ms | 34-37 ms | 135.000 frame/s, 101 MB/s |
| | 120.000 | **100%: non regge** | | | |
| Città (Gauss, 8 km) | 80.000 | 51% | 279 / 521 ms | 21 ms | 117.000 frame/s, 63 MB/s |
| | 120.000 | 79% | 287 / 534 ms | 34 ms | 176.000 frame/s, 96 MB/s |
| | 160.000 | **100%: non regge** | | | |
| Europa (300 città) | 80.000 | 38% | 277 / 518 ms | 18 ms | 70.000 frame/s, 31 MB/s |
| | 160.000 | 76% | 287 / 531 ms | 31 ms | 173.000 frame/s, 82 MB/s |
| | 200.000 | **100%: non regge** | | | |
| Piazza, **tutti in movimento** | 40.000 | 47% | 317 / 567 ms | 66 ms | 76.000 frame/s, 178 MB/s |
| Europa, **tutti in movimento** | 80.000 | 51% | 325 / 573 ms | 73 ms | 111.000 frame/s, 135 MB/s |

Il frame aspetta il giro da 0,5 s, quindi il p50 di circa 250 ms è voluto. A ogni livello: nessun frame perso, coppie tutte coerenti, risultati esatti contro il calcolo su tutti. Il GC non pesa: 0,02 core e pause sotto il millisecondo. Il grosso del lavoro è il calcolo dei vicini: un ricalcolo costa 16-33 µs al p50 e meno di 100 µs al p99.

**Limiti**: è un Mac, non il server: rilancia la stessa prova sulla macchina vera (`./run.sh ladder piazza`), perché la velocità del core cambia il tetto. **La parte più pesante non è qui**: quei frame vanno scritti sui socket (§12).

### 4.5 Privacy: una decisione per coppia, una volta sola

Le regole di `API.md` si applicano **quando si forma la coppia**, non a ogni aggiornamento:

| Spettatore / Osservato | Visible | Approximate | Invisible |
|---|---|---|---|
| **Visible** | preciso | area | mai |
| **Approximate** | area | area | mai |
| **Invisible** | mai | mai | mai |

- **Blocchi**: chi è bloccato, in qualsiasi direzione, non entra mai nella coppia. Un blocco appena fatto
  rompe subito la coppia, e il telefono riceve `removed`.
- **Due record per persona**: la presenza prepara per ognuno il record **preciso** e quello **d'area**,
  una volta sola, e copia i byte giusti a ogni spettatore. Niente serializzazioni per coppia. Il record
  d'area cambia solo quando la persona entra in un altro quadrato da 300 m.
- **Anti-triangolazione**: distanza e limite di 1 km di una coppia `area` si calcolano dal punto mostrato
  (`_area_point`), mai dalla posizione reale dell'altro, altrimenti camminando lungo il bordo si ricostruirebbe il cerchio attorno al
  posto vero. Vale anche se è lo spettatore a essere Approximate. La soluzione è nel paragrafo sotto: tre indici, senza margini.
- **La chiave HMAC del punto d'area** è una configurazione stabile, non casuale per processo come in
  Python, altrimenti a ogni riavvio il punto salterebbe, e facendo la media si potrebbe stimare la
  posizione.
- **La reale di chi è Approximate** resta nel solo processo di presenza.
- **Il telefono non sceglie niente**: manda la posizione e il server decide chi vede. Uno script non può
  guardare altre zone del mondo. `position_guard` resta, e rifiuta i salti impossibili.

**Tre indici, ognuno con i punti giusti.** Una coppia misura la distanza dalla posizione reale di chi guarda al punto che le è mostrato
(`realtime.in_range`). Quindi ogni indice contiene esattamente quei punti:

| Indice | Contiene | Chi lo interroga |
|---|---|---|
| `realVisible` | la posizione reale di chi è Visible | spettatori Visible (coppie `precise`) |
| `areaVisible` | il punto d'area di chi è Visible | spettatori Approximate (coppie `area`) |
| `areaApprox` | il punto d'area di chi è Approximate | tutti (coppie `area`) |

Invisible non sta in nessun indice. La posizione reale di chi è Approximate non sta in nessun indice: resta sulla sua scheda in memoria. Chi guarda fa **due** ricerche
dalla sua posizione reale (`realVisible` o `areaVisible`, più `areaApprox`) e fonde i due risultati già ordinati.

Una versione precedente di questa scheda cercava sulle posizioni reali fino alla venticinquesima + 300 m e poi ricalcolava: in una piazza da 50.000
persone in 300 m vuol dire leggerle tutte, per ognuno, ogni 5 s. Era di nuovo il costo quadratico che tutto il progetto vuole evitare.

- Un Visible che si muove aggiorna `realVisible`. Gli indici d'area cambiano solo quando la persona entra in un altro quadrato, o al cambio di giorno UTC (il punto dipende dal
  giorno): si ricalcola al suo primo frame successivo, senza spazzate, quindi a mezzanotte l'aggiornamento si spalma sui 15 s dei keepalive.
- La ricerca chiede k = 26 (i 25 più sé stesso). Se tolti sé stesso e i bloccati ne restano meno di 25 e l'indice ne aveva ancora, si rifà con k doppio.
- Connessioni, chi ha appena salutato e chi è già sullo schermo si aggiungono con la distanza calcolata direttamente, con gli stessi filtri (§4.6).

**Le distanze sono sulla sfera, come nell'app.** `distance_m` usa la formula haversine con raggio 6.371.000 m. Gli indici non contengono latitudine e longitudine ma tre coordinate in
metri sulla stessa sfera:

```java
static final double R = 6_371_000;

static double[] xyz(double lat, double lon) {
    double a = Math.toRadians(lat), b = Math.toRadians(lon);
    return new double[] {R * Math.cos(a) * Math.cos(b), R * Math.cos(a) * Math.sin(b), R * Math.sin(a)};
}
static double arcToChord(double metres) { return 2 * R * Math.sin(metres / (2 * R)); }   // 1 km → limite per l'indice
static double chordToArc(double chord)  { return 2 * R * Math.asin(Math.min(1, chord / (2 * R))); }
```

La distanza dritta tra due punti cresce insieme a quella sulla superficie, quindi l'ordine dei vicini è identico a `distance_m`, e poli e antimeridiano non sono casi speciali.
**Provato**: 4.131 confronti con la formula esatta, anche a cavallo dell'antimeridiano, vicino ai poli e con persone nello stesso punto, nessuna differenza oltre il
millimetro. Indicizzando invece latitudine e longitudine come numeri, a Roma il bordo di 1 km diventa 744 m verso est, e il 10% dei 25 scelti è sbagliato.

### 4.6 Chi sono i 25, senza sfarfallii

L'ordine è rigido, e il Python è il riferimento (`visible_to`):

1. **Le connessioni** entro 1 km (lookup diretto della lista, non passa dall'indice): un amico non sparisce mai in una folla.
   Con più di 25 connessioni vicine, le 25 più vicine.
2. **Chi ti ha appena salutato**, per 60 s: la mappa esegue un gesto solo su chi mostra, altrimenti lo scarta. Il delta parte
   prima, il gesto 0,3 s dopo (`PINNED_S`). **Mai al posto di una connessione**: venticinque sconosciuti che salutano, magari
   con account finti, non possono nasconderti gli amici. Il prezzo è un caso limite: con 25 connessioni attorno il saluto di
   uno sconosciuto non si vede.
3. **I più vicini**, con il bordo del cerchio di 1 km esatto.
4. **Dentro lo stesso gruppo, chi è già sullo schermo conta come se fosse il 15% più vicino**, altrimenti in una folla due persone
   alla stessa distanza si darebbero il cambio di continuo. Il valore è configurabile.

Realizzato in `backend/app/realtime.py` (`MAX_SHOWN`, `SHOWN_ADVANTAGE`, `PINNED_S`), con i test in
`test_presence_cap.py`.

**Cosa cambia per chi usa l'app, in una folla:**

| Azione | Regola |
|---|---|
| Vedere sulla mappa | i 25: connessioni, poi chi ti ha appena salutato, poi i più vicini |
| Essere visti | ognuno ti vede se sei tra i suoi 25: chi ti sta vicino ti vede |
| Scrivere, salutare, invitare | basta essere entro 1 km, sullo schermo o no |
| Annunci a tutti | li ricevono solo quelli che ti hanno sullo schermo (`watchers`): al massimo qualche decina, quindi non si può spammare una piazza intera |
| "N persone ti vedono" | è `len(watchers[persona])`, mandato in `presence.delta.audience` quando cambia. L'app lo mostra sulla mappa perché nessuno sia guardato senza saperlo, e in una folla è diverso da chi vedi tu |

**Dati mobili, con l'app di oggi**: il server deve usare i frame di `API.md` (`presence.snapshot`,
`presence.delta`), testo JSON. Un record è circa 190 byte: al massimo circa 4,8 KB/s con 25 persone tutte in
movimento, circa 1,2 KB/s col 25% in movimento (stima, prima della compressione). Il record si serializza una
volta sola per persona a ogni giro da 0,5 s e si copiano i byte. Un keepalive che non cambia la posizione
mostrata non genera consegne. Il campo `user` va mandato la prima volta su ogni connessione (l'app azzera i nomi
a ogni `ready`) e quando il riassunto cambia, quindi serve `known` per socket.

Il formato compatto con handle (40 byte) è un'ottimizzazione futura che richiede di cambiare l'app (§11): a questi numeri non
serve per partire. Il rallentamento per distanza non serve: resta solo come valvola di sicurezza sotto carico.

### 4.7 Partizione, guasti e perché non ci sono frontiere

**Un solo processo di presenza**, con una riserva pronta, per tutto il continente. Con le misure del §4.4 e il thread tenuto sotto il 70%, il matching regge circa 80.000 persone sulla mappa nella
piazza e circa 150.000 distribuite in tante città, cioè **4-7 milioni di utenti al giorno** con le ipotesi del §2. Misurato su un Mac e senza la rete: da riconfermare col §12. Se un
thread non bastasse, prima si sposta fuori da esso ciò che non tocca gli indici (costruire i JSON, inviare), e solo dopo si divide per continente: gli indici non si
possono leggere da altri thread mentre cambiano.

**Con una partizione unica non esiste nessuna frontiera**, nemmeno interna.

| Fase | Cosa fare |
|---|---|
| Finché basta una macchina | un processo. **Niente celle, regioni, confini** |
| Più continenti | un processo per continente: gli oceani sono frontiere dove nessuno cammina |
| Se un continente non bastasse | due processi con **zone sovrapposte di 1 km**: chi è vicino al confine è presente su entrambi, come copia. Il confine si mette dove c'è poca gente |

**Se cade**: i telefoni ripetono la posizione entro 15 s, e la riserva ricostruisce tutto. Niente repliche
e niente Redis, e la perdita è qualche secondo di mappa ferma.

**Chi è la presenza attiva**: chi tiene un advisory lock su Postgres (`pg_try_advisory_lock`). La riserva prova a
prenderlo ogni secondo: così non ce ne sono mai due. Quando cambia, i gateway le ripresentano i socket aperti (§5). **Attenzione a tre dettagli**:

- il lock appartiene alla connessione, quindi serve **una connessione dedicata, fuori da HikariCP**: restituita al pool, il lock resterebbe in mano a chiunque la riprenda;
- quella connessione si controlla ogni secondo con `SELECT 1`, e **al primo errore la presenza si ferma subito**: perdendo la connessione Postgres libera il lock, e la riserva parte;
- niente PgBouncer in modalità transazione su quella connessione.

**Altri dati sulla stessa macchina**: `position_guard` e il tempo di riavvio. Il primo matching di un
milione di persone costa decine di secondi su un core: si spalma nel tempo, durante il quale le persone
appaiono progressivamente.

### 4.8 Eventi: PostGIS

Un evento decide da quanto lontano si vede (100-800 m gratis, fino a 10 km a pagamento). Qui **PostGIS è
lo strumento giusto**: gli eventi cambiano di rado, devono restare su disco, e l'indice GiST risponde
esattamente alla domanda. Niente griglie fatte in casa.

```sql
-- eventi normali: reach massimo 800 m
SELECT … FROM events
 WHERE ST_DWithin(location, $punto, 800)
   AND ST_Distance(location, $punto) <= LEAST(reach, $range)
   AND cancelled_at IS NULL AND ends_at > now() - interval '1 day'
   AND ($categorie IS NULL OR categories && $categorie);

-- più quelli promossi: una tabella piccola con la sua posizione e il suo indice
SELECT … FROM promotions p JOIN events e ON e.id = p.event_id
 WHERE ST_DWithin(p.location, $punto, 10000)
   AND ST_Distance(p.location, $punto) <= LEAST(p.radius, $range)
   AND p.paid_until > now()
   AND e.cancelled_at IS NULL AND e.ends_at > now() - interval '1 day'
   AND ($categorie IS NULL OR e.categories && $categorie);
```

Le due liste si uniscono togliendo i doppioni, dalla più vicina, al massimo 200 (`API.md`). `range` va riportato tra
100 m e 10 km, e categorie sconosciute sono un 400. `sponsored` e `reach` vengono dalla promozione pagata, e l'ordine
"due sponsorizzati in cima" lo decide l'app.

Un evento flash ha sempre `reach` 800. `paid_until` non supera mai la fine dell'evento, e `promotions.location` si
aggiorna insieme all'evento quando viene spostato. Promossa vuol dire: `live` o `stopped`, tempo pagato non finito, evento non
annullato e non finito (`promotions.sponsored`); una `paused` torna al reach gratuito.

Separarli evita di leggere ogni evento entro 10 km a ogni richiesta: in un centro città sarebbero tanti,
e la promozione riguarda pochissimi.

**La cache è ciò che rende economica la lettura**. `GET /events` oggi calcola tutto per persona, ma quasi
tutta la risposta è uguale per tutti:

| Parte | Contenuto | Dove si calcola |
|---|---|---|
| **Pubblica** | titolo, luogo, date, tema, contatori, organizzatore, `reach`, `sponsored` | cache in RAM di `api` per 15 s, chiave **punto + `range` + categorie** |
| **Personale** | `following`, `saved`, `friendsGoing`, `friends`; via gli organizzatori bloccati | una query per utente, al volo |

```sql
-- la parte personale, una query sola per tutta la lista
SELECT event_id, user_id FROM event_attendees
 WHERE event_id = ANY($eventi) AND user_id = ANY($mie_connessioni);
```

Il punto è già arrotondato a circa 110 m dal client (`searchPoint`), quindi le risposte si ripetono per
chi sta vicino, e costano un 304.

**Ordine dentro `GET /events`**, da rispettare anche quando la risposta viene dalla cache:

1. valida i parametri;
2. `searchedEvents` alla presenza: controlla che la posizione sia possibile (altrimenti 409 `position_rejected`) e
   registra il punto per il tempo reale;
3. prendi la parte pubblica dalla cache o da PostGIS;
4. aggiungi la parte personale e togli i bloccati;
5. calcola l'ETag sul corpo finale, che è diverso per ogni utente.

**Tempo reale degli eventi**: `notify_event` oggi scorre tutti i client online. La presenza tiene un
**altro indice**, a parte dai tre del §4.5, con il punto e il raggio dell'ultimo `GET /events` di ciascuno, Invisible compresi (riga C1c della
conservazione: arrotondato, in memoria, finché l'app è connessa e 10 minuti dopo l'ultima ricerca se non lo è). Chi non
ha mai cercato ma è sulla mappa conta come 2 km attorno alla sua posizione.

Quando un evento viene creato, cambiato o annullato, i destinatari **online** sono:

- l'organizzatore, chi partecipa e chi l'ha salvato (non bloccato);
- chi ha l'evento dentro `min(raggio cercato, reach)`, non bloccato. `reach` è il maggiore tra quello nuovo e quello di
  prima: se è diminuito, il frame serve proprio a far togliere l'evento a chi ora è troppo lontano.

Il frame è **personale** (`following`, `saved`, `friends`): la parte pubblica si costruisce una volta, quella personale
con una query sola per tutti i destinatari, poi si manda a ciascuno su `u.<utente>`. Gli eventi cambiano di rado, quindi
è poco lavoro. Se i partecipanti online sono migliaia, conviene farlo in un lavoro a lotti, non nella richiesta.

### 4.9 Controlli puntuali

| Regola | Come | Note |
|---|---|---|
| **15 m tra eventi** | `ST_DWithin` dentro un lock esplicito sulla zona (§7.3) | **non** `SERIALIZABLE`: è stato provato, e non basta |
| **Flash entro 500 m** | posizione dalla presenza, altrimenti `from` | timeout 200 ms, poi `from`; senza nessuna delle due, 409 `position_needed` |
| **Connessione entro 100 m** | posizioni nella richiesta, altrimenti presenza | come oggi, `_too_far` |
| **Dove vi siete incontrati, 150 m** | `ST_DWithin` sugli eventi in corso | raro |
| **Posso scrivere?** (`are_near`) | chiamata `near` alla presenza, **a lotti**: distanza esatta tra due punti, senza indice | per l'inbox: solo i non connessi. Se la presenza non risponde: non vicini (`away`) |
| **Gesti, inviti** | li decide la presenza | §4.10 |

PostGIS calcola sullo sferoide, il Python e la presenza sulla sfera: la differenza arriva allo 0,5%. Nessuna regola dipende dal singolo metro, quindi va bene così.

### 4.10 Il protocollo del socket, passo per passo

**Apertura** (solo testo JSON; niente token nell'URL):

1. Il primo frame è `{type:"auth", token}`, entro 5 s. Se manca, se è binario o il token non vale: chiusura 4001. Se l'account non
   esiste si crea, come con `GET /me`. Verificare il token può chiedere le chiavi a Logto e toccare il database: si fa su un virtual thread, mai dentro il callback del socket.
2. Si risponde `{type:"ready", userId}` e si arma un timer alla scadenza del token: alla scadenza, chiusura 4001
   (l'app si riconnette subito con un token nuovo).
3. Il gateway annuncia il socket alla presenza (`socketOpened`, §5), che carica connessioni, blocchi e riassunto
   dell'utente prima del suo primo matching.

**Limiti di ogni socket**: 64 KB a frame (oltre: 1009); 10 frame al secondo, picchi di 30 (oltre: 1008); 5 socket per utente (il sesto
chiude il più vecchio, 1008); 500 frame in coda verso un telefono che non legge (1013). Ping del protocollo ogni 25 s, e
risposta `pong` al `ping` dell'app, che dopo 40 s di silenzio si riconnette. Cloudflare chiude un WebSocket fermo da circa 100 s: i ping lo tengono aperto.

**Compressione spenta** (`permessage-deflate`): il socket di React Native su iOS non la chiede, quindi il vantaggio sarebbe solo per una parte dei telefoni, e ogni socket compresso tiene memoria nativa in più.
Jetty la accetta da solo se il telefono la offre, quindi va spenta esplicitamente (§5). Si può accendere più avanti senza cambiare l'app: è una trattativa all'apertura.

**Le risposte**: se un frame ha `ref`, si risponde `{type:"ack", ref, …}` o `{type:"error", ref, code, message}`. L'app
aspetta 8 s. `presence` non ha `ack`, solo l'eventuale errore.

**Il frame `presence`**:

| Arriva | Cosa fa il server |
|---|---|
| `mode` sconosciuto, coordinate fuori scala | `error` 400 `bad_request` |
| `heading` fuori da 0-360, `speed` fuori da 0-150, `accuracy` negativa o enorme | il valore conta come assente. **Finiscono sui telefoni degli altri**: nel Python un `heading` di 10^300 bloccava il socket di chiunque vedesse quella persona (`test_numbers_out_of_their_range_reach_nobody`) |
| Posizione impossibile (`position_guard`) | `error` 409 `position_rejected`; la presenza resta dov'era e scade da sola |
| `visible` o `approximate` con posizione | aggiorna. Se è il primo su questo socket o il modo è cambiato: `presence.snapshot` subito, e matching di chi ha attorno |
| `visible` o `approximate` con `position: null` | esce da mappa e indice; agli altri `removed`, a lui `removed` di tutti |
| `invisible` | come sopra, più `presence.snapshot` con `people: []` subito |
| Socket chiuso | se era quello che mandava la posizione, o non ne restano altri: esce subito da tutte le mappe |
| 45 s senza frame | esce (connessione persa senza avviso) |

**Quante persone ti vedono**: `presence.delta` porta `audience` (un delta anche senza persone) quando cambia
`len(watchers[persona])`, e di nuovo dopo ogni snapshot. È ciò che l'app mostra ("N people nearby can see you") ed è ciò che
promette il frame `broadcast`: `recipients` nell'ack deve essere lo stesso numero.

**Il giro ogni 0,5 s**: per ogni spettatore si confronta ciò che ha già ricevuto con ciò che dovrebbe vedere:
`(precision, lat, lon a 6 decimali, heading intero, speed a 1 decimale, moving)`. Va nel `presence.delta` solo ciò che è
cambiato, più i `removed`; se non c'è niente, nessun frame. Il record d'area non ha mai `heading`, `speed`, `moving`. La
vista è per utente, mentre `known` (a chi è già stato mandato il `user`) e il "primo frame" sono per socket: un utente può
avere più telefoni.

**Quando rifare subito il matching**, senza aspettare i 5 s: ingresso sulla mappa, cambio di modo (cambia la precisione
di tutte le sue coppie), blocco o sblocco, nuova connessione o connessione finita, saluto ricevuto (§4.6).

**Le azioni**. "Vicino" significa: entrambi sulla mappa, nessuno Invisible, nessun blocco, entro 1 km calcolato come la
coppia (dal punto d'area se la coppia è `area`). Il tetto di 25 non conta.

| Frame | Regole | Risposta |
|---|---|---|
| `gesture` | gesto valido, destinatario esistente e vicino, 1 ogni 2 s per coppia, 60 al minuto per persona. Chi saluta entra tra i 25 dell'altro per 60 s (dopo le sue connessioni): se non c'era, prima il delta, il gesto dopo 0,3 s | `ack {}`; 400, 404, 403 `forbidden`, 429 |
| `broadcast` | 1-120 caratteri dopo il trim, non Invisible, 1 ogni 10 s. Va a `watchers[mittente]` | `ack {recipients}`; 400, 403, 429 |
| `connect.invite` | vicino, non connesso, 1 ogni 10 s per coppia, 30 l'ora per persona, valido 1 minuto. Chi invita mostra il codice, l'altro lo scansiona. Crea anche una notifica `connect.invite`, quindi la presenza chiama `notify` | `ack {invite}`; 404, 403, 409 `already`, 429 |
| `connect.answer` | solo l'invitato, entro il minuto | `ack {}`; 410 `expired` |

## 5. Servizi: un eseguibile, quattro ruoli

**Decisione: non microservizi, ma un monolite modulare con ruoli separati**, cioè lo stesso jar
avviato con `--roles=`. All'inizio tutti i ruoli girano insieme su una macchina; quando serve si
separano senza riscrivere nulla.

| Ruolo | Fa | Stato | Scala con | Risorsa critica |
|---|---|---|---|---|
| `gateway` | socket, autenticazione, inoltro frame | socket | utenti connessi | RAM, rete |
| `presence` | **il servizio di matching**: indici, coppie, consegne, TTL, punti d'area | RAM, ricostruibile | persone sulla mappa | CPU |
| `api` | tutto il REST | nessuno (cache) | richieste | CPU |
| `worker` | push, addebiti, promemoria, conservazione, cancellazioni | nessuno | code | CPU |

Il criterio è **la forma del carico**, non il dominio: si separa ciò che scala diversamente.
Fuori da questo jar restano:

- **`imaged`, un piccolo programma Java a parte che lancia `vips thumbnail` per ogni immagine** (§19). `API.md` vuole il risultato **nella
  stessa richiesta** (URL finali, oppure 422 `moderated`), quindi niente coda: `api` lo chiama e aspetta, con un
  numero massimo di elaborazioni parallele e meno dei 15 s di timeout dell'app. Così il codice C non gira mai nella JVM principale: un crash o un exploit
  su un'immagine malevola muore con il suo processo e non tocca socket e API;
- il **baker degli avatar** resta Node (`asset-pipeline/src/mapAvatar.mjs`): riscriverlo non porta
  niente, e il risultato è indirizzato per contenuto, quindi si fa una volta per look;
- i **tile** e i file degli avatar sono statici, serviti dalla CDN, senza toccare il backend.

**Perché non quattro servizi** (Account, Eventi, Realtime, Media): quella
divisione per dominio costringe a copie locali di blocchi e connessioni, saghe per la cancellazione
degli account, outbox tra servizi. Tutto lavoro in più per un team di una persona, per un problema che
non c'è: **il collo di bottiglia è la presenza, e i ruoli la isolano già**. Con un database solo, la
cancellazione di un account è una transazione, e `sees_story` è una join. I confini tra i moduli
tengono aperta la divisione per il giorno in cui servirà davvero.

### Struttura del codice

Un progetto Gradle con più moduli. I confini sono controllati da un test (ArchUnit, §21), non dalla buona volontà:

```
settings.gradle.kts, gradle/libs.versions.toml, gradle/verification-metadata.xml
core/       id, errori, testo, tempi, JSON, distanze e punti d'area   (nessun framework)
bus/        interfaccia + in-process + NATS
presence/   indici, coppie, consegna, isteresi                        (solo JDK e PH-Tree: mai Spring, mai database)
gateway/    socket con l'API di Jetty, autenticazione, inoltro        (mai Spring)
auth/       chiavi di Logto, token, versione minima
store/      migrazioni Flyway, classi generate da jOOQ, transazioni
api/        Spring MVC: people/ events/ chats/ notifications/ promotions/ media/ privacy/ moderation/
            ciascuno: controller + regole + query
jobs/       lavori db-scheduler
app/        main: legge --roles e avvia ciò che serve; Spring parte solo con api o worker
imaged/     le immagini: programma a parte, non dipende dagli altri moduli
```

**La regola che tiene aperte le porte**: i moduli si parlano attraverso interfacce piccole, e
`bus` ha una versione in-process. Così su una sola macchina non serve nemmeno NATS.

### Come scrivere `presence`

**Un solo thread normale (non virtual) possiede indici e coppie, e nessun altro li tocca.** Nessun lock, nessuna gara: è la scelta che
toglie più bug possibili dalla parte più difficile. Gli altri gli scrivono soltanto:

- **due code**: `frames` è limitata (`ArrayBlockingQueue`, circa 2 secondi di traffico) e con `offer`, che non blocca mai: se è piena il frame si perde e si conta, tanto il telefono ne manda un altro. `control`
  (socket aperti e chiusi, relazioni, chiamate con risposta) non si perde mai, e si svuota per prima;
- **una chiamata con risposta** è un messaggio con dentro un `CompletableFuture`: chi chiama aspetta sul suo virtual thread, con `orTimeout` a 200 ms;
- **il thread non blocca mai**: niente database, rete, file o sleep lunghi. Ciò che serve da fuori (relazioni, riassunti) si chiede su un virtual thread, e il risultato torna come messaggio in `control`, con il numero di versione della richiesta: se nel frattempo è arrivato un `relationChanged`, un risultato
  vecchio si scarta e si richiede;
- **un'eccezione su un messaggio non ferma il giro**: si cattura attorno al singolo messaggio, si conta e si registra senza coordinate. Un watchdog esterno controlla che il giro avanzi: fermo da 5 s, il processo esce e subentra la riserva (§4.7);
- **i frame ricevuti sono tipi chiusi**: `sealed interface ClientFrame` con un record per tipo (`Position`, `Gesture`, `Broadcast`, `Device`, `ConnectInvite`, `ConnectAnswer`), letti e validati nel gateway. Uno `switch` senza `default` non compila se manca un caso.

Il §4.4 dice che un core regge a lungo: parallelizzare è un problema da affrontare solo quando servirà davvero.

**Indice in memoria**: `PhTreeMultiMapF` della libreria `phtree`, tre dimensioni (§4.5), dietro un'interfaccia `NearIndex` di quattro metodi (aggiungi, sposta, togli, i k più vicini). È una *multimap*: due persone nello stesso punto esatto non si sovrascrivono. La
query si riusa con `reset(k, null, centro)` e `nextEntryReuse()`, quindi alloca poco, ed è per questo che non si può condividere tra thread.

### Come scrivere `gateway`

Il socket non ha un thread per connessione: Jetty chiama dei callback, che **non devono mai bloccare**. Leggono il frame, lo validano, fanno `offer` alla presenza e tornano. Provato su un server vero, con Spring Boot sulla stessa porta (serve in sviluppo, §13):

```java
@Bean
JettyServerCustomizer websockets(Gateway gateway) {
    return server -> {
        server.setErrorHandler(new JsonErrorHandler());   // anche gli errori di Jetty in JSON (§16)
        Handler rest = server.getHandler();
        WebSocketUpgradeHandler ws = WebSocketUpgradeHandler.from(server, container -> {
            container.setMaxTextMessageSize(64 * 1024);
            container.setMaxBinaryMessageSize(64 * 1024);
            container.setIdleTimeout(Duration.ofSeconds(90));
            container.setMaxOutgoingFrames(500);
            container.addMapping("/v1/ws", (request, response, callback) -> {
                response.setExtensions(List.of());        // niente permessage-deflate (§4.10)
                return gateway.newSocket();               // la classe deve essere public, o Jetty risponde 500
            });
        });
        ws.setHandler(rest);                              // tutto il resto va a Spring
        server.setHandler(ws);
    };
}
```

Su una macchina con il solo ruolo `gateway` si fa la stessa cosa su un `new Server()`, senza Spring.

- **La classe del socket estende `Session.Listener.AbstractAutoDemanding` ed è `public`.** Un frame binario arriva a `onWebSocketBinary`: `callback.succeed()` va chiamato sempre.
- **Mandare**: `session.sendText(testo, callback)` non blocca mai. **Telefono lento** (provato con un client che non legge): oltre 500 frame in coda il callback fallisce con `WritePendingException`, e fallisce per ogni frame successivo, quindi si reagisce solo alla
  prima volta. La chiusura 1013 spesso non può arrivare, perché la connessione è piena: se anche `close` fallisce, `session.disconnect()`. Il telefono si riconnette da solo dopo il suo silenzio di 40 s.
- **La presenza non chiama mai `sendText`**: anche se non blocca, scrive sul socket nel thread di chi chiama, e migliaia di socket fermerebbero il giro. Consegna il pacco a un piccolo gruppo di thread del gateway, un thread per ogni gruppo di socket.
- **Spegnendo il gateway** i socket si chiudono a poco a poco in 30-60 s: tutti insieme tornerebbero tutti insieme.

### Come parlano i ruoli

`api`, `worker` e `gateway` non leggono mai dentro la presenza: usano questa interfaccia. Con una macchina sola è un messaggio in coda verso il thread della presenza; con più macchine, la stessa interfaccia passa da NATS
request/reply. Nessuna posizione finisce in log o code persistenti.

```java
public interface Presence {
    // Dal gateway: non bloccano mai
    void socketOpened(UserId user, SocketId socket, GatewayId gateway);
    void socketClosed(UserId user, SocketId socket);
    void frame(UserId user, SocketId socket, ClientFrame frame);   // presence, gesture, broadcast, device, connect.*

    // Da api e worker, con risposta: chi aspetta usa orTimeout(200 ms)
    CompletableFuture<Map<UserId, Boolean>> near(UserId viewer, List<UserId> others);
    CompletableFuture<Optional<Point>> position(UserId user);       // flash, connessione di persona
    CompletableFuture<Boolean> plausible(UserId user, Point p);     // from di flash, connessione
    CompletableFuture<Boolean> searchedEvents(UserId user, Point p, int rangeM);
    CompletableFuture<List<UserId>> eventAudience(Point p, int reachM);
    CompletableFuture<List<UserId>> online(List<UserId> users);

    // Notizie: si ripetono finché la presenza non conferma
    void relationChanged(UserId a, UserId b);   // blocco, sblocco, connessione nuova o finita
    void userChanged(UserId user);              // nome, foto, avatar: il `user` riparte verso chi lo vede
    void accountErased(UserId user);            // via dalla mappa, dagli indici e dal position guard
}

// Ciò che la presenza chiede fuori da sé: non tocca direttamente il database, e non blocca il suo thread
public interface Directory {
    CompletableFuture<Relations> relations(UserId user);            // connessioni, blocchi nei due versi
    CompletableFuture<UserSummary> summary(UserId user);
    void notify(UserId user, String kind, UserId actor);            // connect.invite
}
```

Finché il riassunto di una persona non è arrivato, quella persona entra nel delta al giro successivo: 0,5 s dopo, non è un errore.

**Se la presenza non risponde**, la regola dipende da cosa si rischia:

| Chiamata | Senza risposta | Perché |
|---|---|---|
| `near` | non vicini: `canWrite: false`, `why: "away"` | meglio rifiutare un messaggio che farlo passare |
| `position` | usa `from`, altrimenti `position_needed` | come per chi è Invisible |
| `plausible`, `searchedEvents` | si prosegue | è un controllo anti-abuso, e alla ripartenza il position guard è comunque vuoto |
| `eventAudience`, `online` | frame non mandati, push mandati | il telefono recupera ricaricando le liste; un push in più è il danno minore |

**Un blocco non può andare perso**, quindi `relationChanged` parte da un lavoro db-scheduler inserito nella transazione del blocco
e ripetuto finché la presenza non conferma: core NATS da solo può perdere messaggi. La presenza tiene connessioni e
blocchi in RAM solo per chi ha un socket aperto, e li ricarica a ogni `socketOpened`.

### Librerie

Versioni controllate su Maven Central il 2026-11-04. **Quelle che gestisce il BOM di Spring Boot non si scrivono a mano**: si aggiornano insieme, già provate tra loro. Le altre stanno in `libs.versions.toml`.

| Serve per | Scelta | Versione | Perché |
|---|---|---|---|
| JVM | Temurin JDK 25 LTS | 25.0.x | supporto almeno fino a settembre 2031; virtual thread senza il blocco su `synchronized` (JEP 491), ZGC generazionale, intestazioni compatte (JEP 519) |
| Build | Gradle (Kotlin DSL, wrapper nel repo) | 9.8 | blocco e verifica delle dipendenze già inclusi (§21) |
| REST | Spring Boot + Spring MVC + Jetty, su virtual thread | 4.1.2 (4.2 attesa a novembre 2026) | codice normale che blocca, senza programmazione reattiva; la strada più documentata e collaudata. Ogni minor ha circa 13 mesi di supporto gratuito: un aggiornamento l'anno è obbligatorio |
| WebSocket | API di Jetty | 12.1 (BOM) | stesso server del REST, buffer gestiti da lui, coda limitata per socket. Provato, sopra |
| JSON | Jackson 3 (`tools.jackson`) | 3.1 (BOM) | configurato stretto, §16: quello predefinito accetta `8.5` come intero |
| Postgres | pgjdbc + HikariCP + jOOQ OSS | BOM | SQL vero e tipi generati dallo schema, nessun ORM. Una colonna rinominata non compila più. PostGIS con modelli `DSL.condition("ST_DWithin(location, {0}, {1})", …)`: sempre parametri, mai stringhe concatenate |
| Geo su disco | PostGIS | 3.6 o più | §4.8 |
| Indice in memoria | `ch.ethz.globis.phtree:phtree` | 2.8.2 | §15. Apache 2.0; ha un solo autore, quindi sta dietro `NearIndex`, con un test contro il calcolo esatto (§21) |
| Migrazioni | Flyway + `flyway-database-postgresql` | BOM | file SQL semplici. Si lanciano come passo del rilascio, non all'avvio di ogni nodo |
| Code | `db-scheduler` + `db-scheduler-spring-boot-4-starter` | 16.12 | gira su Postgres, inserimento **dentro la transazione** (provato, §6) |
| Bus | `io.nats:jnats` | 2.26 | core NATS, senza persistenza, solo con più macchine |
| Cache in RAM | Caffeine | BOM | |
| Cache condivisa | Lettuce | BOM | limiti, token di connessione, solo con più macchine. Parla con Valkey |
| JWT | `com.nimbusds:nimbus-jose-jwt` | 10.10 | chiavi di Logto con cache, rinnovo e tolleranza ai guasti; lista bianca di algoritmi (provata, §16) |
| Immagini | CLI di libvips (`libvips-tools`) | 8.16 o più | HEIC e WebP, poca memoria, un processo per immagine (§19) |
| Storage | AWS SDK v2 (`s3`, `S3Presigner`) | 2.57 | R2 parla S3; serve la configurazione del §19 |
| Acquisti | `com.apple.itunes.storekit:app-store-server-library`, `google-api-services-androidpublisher` | 5.2, v3 | le librerie ufficiali: non si verifica a mano una catena di firme Apple |
| Push | `com.eatthepath:pushy` (APNs), HTTP v1 di FCM con `google-auth-library-oauth2-http` | 0.15, 1.55 | diretto, D5 |
| Osservabilità | SLF4J + Logback, Micrometer + Prometheus, Grafana, JFR | BOM | gratis, sulle stesse macchine (§21) |

## 6. Bus, cache e memoria: cosa va dove

| Dato | Dove | Se si perde |
|---|---|---|
| Posizioni, coppie, inviti in corso, punti di ricerca, position guard | RAM del ruolo `presence` | si ricostruisce in 15 s |
| Socket | RAM del `gateway` | il telefono si riconnette |
| Frame verso i telefoni | NATS core (at-most-once) | ne arriva un altro, o il client ricarica |
| Limiti, token di connessione | RAM con una macchina sola, Valkey quando le macchine sono più di una (stessa interfaccia) | si riparte da zero per poco: accettabile |
| Account appena cancellati (2 h) | tabella `erased_accounts` + RAM | non si perdono: un token ancora valido non deve ricreare l'account |
| Tutto ciò che deve restare | Postgres | non si perde (§7.6) |
| Lavori asincroni | Postgres (`scheduled_tasks` di db-scheduler) | non si perdono |

**Valkey è una cache normale, e non fa geospazialità** (§15 spiega perché).

**Niente Kafka né NATS JetStream**: i messaggi di chat sono già al sicuro su Postgres *prima* di
essere pubblicati. Il bus serve solo a dire "guarda che c'è una novità": se un frame si perde, il
client lo recupera con `after` alla prossima riconnessione.

**Le code stanno in Postgres grazie a db-scheduler**: un lavoro inserito nella stessa transazione della
modifica parte solo se la modifica è salvata. Questo è l'outbox transazionale che la divisione in
servizi avrebbe reso necessario, ottenuto senza scriverlo. **Provato** con lo starter per Spring Boot 4: con la transazione annullata il lavoro non esiste, con quella confermata parte.

**Tre cose da sapere su db-scheduler**:

- il suo formato predefinito per i dati del lavoro è la serializzazione Java, che qui è vietata (§16): va sostituita con un `Serializer` che scrive JSON, dando un bean `DbSchedulerCustomizer` (provato);
- un lavoro può girare più di una volta, se una macchina cade a metà: **ogni lavoro dev'essere ripetibile** senza danni. Quelli di denaro rileggono tutto sotto lock (§7.3);
- la tabella `scheduled_tasks` si crea con il file `postgresql_tables.sql` del suo repository, nella stessa versione, dentro una migrazione.

`polling-interval` a 1 s, così un lavoro appena accodato parte subito. Sulle macchine `api` serve solo il `SchedulerClient`, l'esecuzione sta sui `worker`.

### Consegna

**Presenza**: ogni 0,5 s, per ogni gateway, la presenza prepara un solo pacco con i frame di tutti i suoi
telefoni. Così i messaggi interni sono due al secondo per gateway, non uno per persona.

**Un messaggio di chat**:

```
POST /chats/{id}/messages
  transazione: INSERT messaggio + UPDATE chats (contatore, ultimo messaggio) + lavoro push
  dopo il commit: publish
    chat piccola (< 200 membri): u.<utente>, una copia per membro
    chat grande:                 c.<chat>, una copia per gateway interessato, con la lista di chi
                                 ha un blocco col mittente: il gateway non la consegna a loro
```

Il push parte solo per chi non ha un socket aperto, controllato dal worker. Nelle chat evento molto
grandi serve anche un limite complessivo per chat, altrimenti il fan-out esplode (§14, D2).

## 7. Database

Un Postgres primario con una replica. A 1 milione di utenti al giorno i messaggi sono circa 230/s di
media e 1.200/s di picco (20 a testa): è comodamente dentro le possibilità di una sola macchina con NVMe.

### 7.1 Schema

**Questo è SQL vero**: è stato eseguito su PostgreSQL 18 con PostGIS, e può essere la prima migrazione di Flyway, insieme a `scheduled_tasks` di db-scheduler (§6). Gli id si
generano nel programma (§7.2). Le chiavi esterne con `ON DELETE CASCADE` hanno un indice sulla colonna, altrimenti ogni cancellazione scorrerebbe tutta la tabella.

```sql
-- La prima migrazione. Gli id si generano nel programma (§7.2), mai con uuidv7() di Postgres.
CREATE EXTENSION postgis;

-- persone
CREATE TABLE users (
  id             uuid PRIMARY KEY,
  sub            text NOT NULL UNIQUE,
  public_id      text NOT NULL UNIQUE,
  username       text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._]{3,30}$'),
  name           text NOT NULL,
  email          text,
  named          boolean NOT NULL DEFAULT false,
  last_active_on date NOT NULL DEFAULT current_date,               -- C3-bis: account inattivi
  bio            text NOT NULL DEFAULT '',
  picture_key    text,
  style          jsonb NOT NULL,
  settings       jsonb NOT NULL,
  story          jsonb,
  story_audience text NOT NULL DEFAULT 'connections' CHECK (story_audience IN ('connections', 'everyone')),
  avatar         jsonb,
  avatar_version int NOT NULL DEFAULT 0,
  map_avatar_key text,
  suspended_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE connections (                                          -- due righe per coppia
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  other_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  since    timestamptz NOT NULL,
  place    text,
  PRIMARY KEY (user_id, other_id),
  CHECK (user_id <> other_id)
);
CREATE INDEX ON connections (other_id);
CREATE TABLE disconnected_pairs (                                   -- a < b
  a uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  b uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX ON disconnected_pairs (b);
CREATE TABLE blocks (
  blocker uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  blocked uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  since   timestamptz NOT NULL,
  PRIMARY KEY (blocker, blocked),
  CHECK (blocker <> blocked)
);
CREATE INDEX ON blocks (blocked);                                   -- si cerca nei due versi
CREATE TABLE story_hidden (
  user_id   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  moment_id text NOT NULL,
  PRIMARY KEY (user_id, moment_id)
);
CREATE TABLE push_tokens (
  token    text PRIMARY KEY CHECK (length(token) <= 256),
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('ios', 'android'))
);
CREATE INDEX ON push_tokens (user_id);
CREATE TABLE consents (
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  kind    text NOT NULL,
  version text NOT NULL,
  mode    text,
  at      timestamptz NOT NULL
);
CREATE INDEX ON consents (user_id, kind, at);

-- eventi
CREATE TABLE events (
  id                    uuid PRIMARY KEY,
  creator_id            uuid NOT NULL REFERENCES users,             -- gli eventi di chi se ne va li toglie DELETE /me
  title                 text NOT NULL,
  description           text NOT NULL DEFAULT '',
  categories            text[] NOT NULL DEFAULT '{}',
  location              geography(Point, 4326) NOT NULL,
  address               text,
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  modified_at           timestamptz,
  cancelled_at          timestamptz,
  links                 text,
  flash                 boolean NOT NULL DEFAULT false,
  spots_needed          int NOT NULL DEFAULT 0,
  theme                 jsonb,          -- sei campi fissi, o NULL: §16, Il tema di un evento
  image_keys            text[] NOT NULL DEFAULT '{}',
  reach                 int NOT NULL,
  follower_count        int NOT NULL DEFAULT 0 CHECK (follower_count >= 0),
  guest_count           int NOT NULL DEFAULT 0 CHECK (guest_count >= 0),
  photo_count           int NOT NULL DEFAULT 0 CHECK (photo_count >= 0),
  rating_count          int NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  rating_sum            double precision NOT NULL DEFAULT 0,        -- il voto può essere decimale
  starting_notified_for timestamptz                                 -- l'inizio per cui è partito "sta per iniziare"; se si sposta, riparte
);
CREATE INDEX events_location ON events USING gist (location) WHERE cancelled_at IS NULL;
CREATE INDEX ON events (creator_id, starts_at DESC);
CREATE INDEX ON events (ends_at);                                   -- conservazione, chat da chiudere
CREATE TABLE event_attendees (
  event_id  uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  joined_at timestamptz NOT NULL,
  public    boolean NOT NULL,                                       -- la scelta di story_audience, copiata
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX ON event_attendees (user_id, joined_at DESC);          -- storia, Saved
CREATE INDEX ON event_attendees (event_id, joined_at) WHERE public; -- "Who's in" per estranei
CREATE TABLE event_saved (
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  since    timestamptz NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX ON event_saved (event_id);
CREATE TABLE saved_hidden (                                         -- tolti dalle liste: solo eventi annullati prima di iniziare
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX ON saved_hidden (event_id);
CREATE TABLE event_ratings (
  id       uuid NOT NULL UNIQUE,                                    -- Rating.id di API.md
  event_id uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  rating   real NOT NULL,
  comment  text,
  date     timestamptz NOT NULL,
  modified timestamptz,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX ON event_ratings (user_id, date DESC);                 -- storia, cancellazione
CREATE TABLE event_photos (
  id         uuid PRIMARY KEY,
  event_id   uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  author_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  key        text NOT NULL,
  thumb_key  text NOT NULL,
  width      int NOT NULL,
  height     int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON event_photos (event_id, id DESC);
CREATE INDEX ON event_photos (event_id, author_id);                 -- quante ne ha aggiunte
CREATE INDEX ON event_photos (author_id, created_at DESC);          -- limiti, cancellazione
CREATE TABLE event_bans (
  event_id uuid NOT NULL REFERENCES events ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX ON event_bans (user_id);
CREATE TABLE album_settings (
  event_id     uuid PRIMARY KEY REFERENCES events ON DELETE CASCADE,
  who_can_post text NOT NULL,
  contributors uuid[] NOT NULL DEFAULT '{}'
);

-- chat: una sola forma per dirette, gruppi, eventi
CREATE TABLE chats (
  id           uuid PRIMARY KEY,
  public_id    text NOT NULL UNIQUE,
  kind         text NOT NULL CHECK (kind IN ('direct', 'group', 'event')),
  title        text,
  color        text,
  picture_key  text,
  owner_id     uuid REFERENCES users ON DELETE SET NULL,
  event_id     uuid UNIQUE REFERENCES events ON DELETE CASCADE,
  read_only    boolean NOT NULL DEFAULT false,
  opened_by    uuid,                                                -- diretta: chi l'ha aperta; finché nessuno scrive si vede solo da lui (§20)
  seq          bigint NOT NULL DEFAULT 0,                           -- l'ultimo messaggio: dà l'ordine
  counter      bigint NOT NULL DEFAULT 0,                           -- messaggi che contano come non letti
  member_count int NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  last_message jsonb,
  last_at      timestamptz,
  large        boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 70);                                           -- aggiornamenti HOT: mai indici su seq, counter, last_*
CREATE INDEX ON chats (owner_id) WHERE owner_id IS NOT NULL;        -- gruppi posseduti (limite 50)
CREATE TABLE chat_members (
  chat_id       uuid NOT NULL REFERENCES chats ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  read_counter  bigint NOT NULL DEFAULT 0,
  read_at       timestamptz,
  muted_until   timestamptz,
  muted_forever boolean NOT NULL DEFAULT false,
  joined_seq    bigint NOT NULL DEFAULT 0,                          -- gruppi: vede da questo messaggio in poi; eventi: 0
  joined_at     timestamptz NOT NULL,
  PRIMARY KEY (chat_id, user_id)
) WITH (fillfactor = 80);
CREATE INDEX ON chat_members (user_id, chat_id);                    -- l'inbox
CREATE TABLE direct_chats (                                         -- a < b
  a       uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  b       uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  chat_id uuid NOT NULL REFERENCES chats ON DELETE CASCADE,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX ON direct_chats (b);
CREATE INDEX ON direct_chats (chat_id);
-- Senza chiavi esterne: chat e account se ne vanno subito, i loro messaggi a lotti (§18)
CREATE TABLE messages (
  chat_id    uuid NOT NULL,
  seq        bigint NOT NULL,
  id         uuid NOT NULL,
  counter    bigint NOT NULL,
  at         timestamptz NOT NULL,
  sender     uuid,                                                  -- NULL: messaggio di sistema senza autore
  text       text NOT NULL DEFAULT '',
  client_id  text,
  system     boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,                                           -- testo svuotato, il posto resta
  poll       jsonb,
  PRIMARY KEY (chat_id, seq),
  UNIQUE (chat_id, id)
) PARTITION BY HASH (chat_id);
DO $$ BEGIN
  FOR i IN 0..63 LOOP
    EXECUTE format('CREATE TABLE messages_%s PARTITION OF messages FOR VALUES WITH (MODULUS 64, REMAINDER %s)', i, i);
  END LOOP;
END $$;
CREATE INDEX ON messages (sender);                                  -- cancellazione dell'account
CREATE TABLE chat_pins (
  chat_id    uuid NOT NULL REFERENCES chats ON DELETE CASCADE,
  message_id uuid NOT NULL,
  pinned_at  timestamptz NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE poll_votes (
  message_id uuid NOT NULL,
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  option_ids text[] NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX ON poll_votes (user_id);                               -- cancellazione
CREATE TABLE sent_messages (                                        -- invio idempotente, 24 h
  chat_id    uuid NOT NULL,
  sender     uuid NOT NULL,
  client_id  text NOT NULL CHECK (length(client_id) <= 64),
  message_id uuid NOT NULL,
  at         timestamptz NOT NULL,
  PRIMARY KEY (chat_id, sender, client_id)
);
CREATE INDEX ON sent_messages (at);                                 -- pulizia a lotti

-- denaro
CREATE TABLE wallets (
  user_id       uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  balance       int NOT NULL DEFAULT 0,                             -- può andare sotto zero (rimborso di un acquisto)
  account_token uuid NOT NULL UNIQUE
);
CREATE TABLE wallet_entries (                                       -- solo aggiunte, mai modifiche
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  at              timestamptz NOT NULL,
  amount          int NOT NULL,
  kind            text NOT NULL,
  event_id        uuid,
  product_id      text,
  store_key       text                                              -- rimborso: trova l'acquisto
);
CREATE INDEX ON wallet_entries (user_id, at DESC);
CREATE INDEX ON wallet_entries (store_key) WHERE store_key IS NOT NULL;
CREATE TABLE store_transactions (                                   -- resta dopo la cancellazione: mai due accrediti
  key     text PRIMARY KEY,
  user_id uuid                                                      -- NULL dopo la cancellazione dell'account
);
CREATE TABLE promotions (
  event_id   uuid PRIMARY KEY REFERENCES events ON DELETE CASCADE,
  location   geography(Point, 4326) NOT NULL,
  radius     int NOT NULL,
  daily      int NOT NULL,
  paid_rate  int NOT NULL,                                          -- il prezzo del tempo già pagato
  started_at timestamptz NOT NULL,
  paid_until timestamptz NOT NULL,
  status     text NOT NULL CHECK (status IN ('live', 'paused', 'stopped', 'ended')),
  charged    int NOT NULL DEFAULT 0 CHECK (charged >= 0),
  refunded   int NOT NULL DEFAULT 0 CHECK (refunded >= 0),
  CHECK (refunded <= charged)
);
CREATE INDEX promotions_location ON promotions USING gist (location) WHERE status IN ('live', 'stopped');
CREATE INDEX ON promotions (paid_until) WHERE status IN ('live', 'stopped');

-- il resto
CREATE TABLE notifications (
  id       uuid PRIMARY KEY,
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  kind     text NOT NULL,
  event_id uuid,
  at       timestamptz NOT NULL,
  actors   uuid[] NOT NULL DEFAULT '{}',
  count    int NOT NULL DEFAULT 1,
  data     jsonb,
  read     boolean NOT NULL DEFAULT false
);
CREATE INDEX ON notifications (user_id, at DESC);                   -- raggruppare: l'ultima uguale non letta entro 24 h, FOR UPDATE
CREATE INDEX ON notifications USING gin (actors);                   -- l'account cancellato esce dalle notifiche degli altri
CREATE INDEX ON notifications (at);                                 -- pulizia oltre 60 giorni
CREATE TABLE export_tokens (                                        -- monouso: DELETE … RETURNING
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX ON export_tokens (expires_at);
CREATE INDEX ON export_tokens (user_id);
CREATE TABLE erased_accounts (
  sub text PRIMARY KEY,
  at  timestamptz NOT NULL
);
CREATE INDEX ON erased_accounts (at);
CREATE TABLE uploads (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  purpose     text NOT NULL,
  mime        text NOT NULL,
  size        bigint NOT NULL CHECK (size > 0),
  width       int,
  height      int,
  event_id    uuid,
  chat_id     uuid,
  storage_key text NOT NULL,
  expires_at  timestamptz NOT NULL,
  claimed_at  timestamptz,                       -- una richiesta lo sta lavorando (§19, Il passo 3): un'altra nel frattempo riceve 409
  output_keys text[] NOT NULL DEFAULT '{}',      -- i nomi scelti per i file rifatti, PRIMA di chiamare imaged: se la richiesta muore a metà, la pulizia sa cosa togliere
  used        boolean NOT NULL DEFAULT false
);
CREATE INDEX ON uploads (user_id) WHERE NOT used;                   -- quanti in attesa
CREATE INDEX ON uploads (expires_at) WHERE NOT used;                -- pulizia
CREATE TABLE reports (
  id         uuid PRIMARY KEY,
  by_user    uuid,                                                  -- NULL quando chi ha segnalato cancella l'account
  snapshot   jsonb NOT NULL,                                        -- com'era ciò che è stato segnalato in quel momento
  kind       text NOT NULL,
  target_id  text NOT NULL,
  event_id   uuid,
  reasons    text[] NOT NULL,
  details    text,
  at         timestamptz NOT NULL,
  status     text NOT NULL DEFAULT 'open',
  handled_by uuid
);
CREATE INDEX ON reports (status, at);
CREATE INDEX ON reports (by_user) WHERE by_user IS NOT NULL;
CREATE TABLE idempotency_keys (
  user_id  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  scope    text NOT NULL,                 -- 'event', 'photo': la stessa chiave su due rotte è un'altra cosa
  key      text NOT NULL CHECK (length(key) BETWEEN 1 AND 64),   -- oltre: 400, come il Python
  made_id  uuid NOT NULL,                 -- ciò che è stato creato: la risposta si rifà com'è ADESSO per chi chiede
  at       timestamptz NOT NULL,
  PRIMARY KEY (user_id, scope, key)
);
CREATE INDEX ON idempotency_keys (at);
```

### 7.2 Le scelte che contano

**ID**: UUID versione 7 nelle tabelle, **generati dal programma con `SecureRandom`, mai con `uuidv7()` di Postgres**. In Postgres 18 i 12 bit dopo la versione
crescono col tempo (provato su 20.000 valori): restano 62 bit casuali, sotto i 72 che `API.md` chiede. Scritti nel programma sono 74 (`Ids`, §16). Verso l'app restano
opachi e con prefisso (`ev_`, `chat_`, `msg_`, `ph_`, `up_`…): il prefisso più i 16 byte in base64url, per esempio `ev_AaGoiVCMeXe_JMQn9ho_vQ`. Un id contiene il momento della
creazione: per eventi, messaggi e foto è già visibile. **`usr_…` no**: 16 byte tutti casuali in `users.public_id`, così nessuno ricava da quanto esiste un account. Un id malformato è un 404 uguale agli altri (§20).

L'id pubblico di una chat evento è `event:<eventId>`: arriva codificato (`event%3Aev_…`), e Spring lo decodifica nel `@PathVariable` (provato). I momenti della storia hanno id stabili, perché vengono
salvati in `story_hidden`: `o-<evento>`, `j-<evento>`, `r-<evento>`, `c-<persona>`.

**Messaggi**: `seq`, cursori, non letti e crescita nel tempo sono al §18.

**Il `sub` di Logto** sta in una colonna sola. Quasi tutto il resto usa `users.id`: si può cambiare
provider d'identità senza toccare nulla. Va fatto dal primo giorno: dopo costa moltissimo.

**Chiave di partizione ovunque**: ogni query sui messaggi porta `chat_id`, e nessuna fa join tra chat.
Quel giorno si potranno spostare le chat su più Postgres **senza riscrivere le query**.

**`public` su `event_attendees`**: "Who's in" per un estraneo deve escludere chi tiene privata la storia,
senza una join su `users` per ogni partecipante di un evento enorme. Si copia la scelta sulla riga, e
quando l'utente cambia impostazione un lavoro aggiorna le sue righe.

**Contatori denormalizzati sull'evento**: `follower_count` e simili, mai `COUNT(*)` in una lista.

### 7.3 Dove serve la concorrenza

Python è sicuro perché ha un solo thread e non fa `await` nel mezzo. In Java con Postgres **quella
garanzia sparisce**, ed è il punto più facile da sbagliare nella riscrittura. Tutte le transazioni sono `READ COMMITTED`, il valore normale: ogni istruzione vede ciò che è già
confermato, e i casi qui sotto si reggono su lock espliciti, `UPDATE` condizionali e vincoli. Ognuna di queste righe vuole un test con gare vere (§21).

| Regola | Soluzione |
|---|---|
| 15 m tra eventi e massimo 5 attivi | **lock esplicito, sotto**. Con `SERIALIZABLE` e il GiST la regola si rompe: 13 volte su 24 sono entrati due eventi nello stesso punto, 12 su 12 in una zona senza altri eventi. Con il lock, 0 su 24 |
| Primo accesso, due richieste insieme | `INSERT INTO users … ON CONFLICT (sub) DO NOTHING`, poi rileggi. L'handle preso è un errore di `UNIQUE`: si riprova con un altro numero |
| Posti di un evento flash | l'organizzatore non conta: colonna `guest_count`. `UPDATE events SET guest_count = guest_count + 1 WHERE id = $1 AND (NOT flash OR spots_needed = 0 OR guest_count < spots_needed) RETURNING …`: se non torna righe è 409 `full` |
| Limiti delle foto (§19) | `UPDATE events SET photo_count = photo_count + 1 WHERE id = $1 AND photo_count < 500 RETURNING …`, poi il conteggio per persona dentro la stessa transazione con `pg_advisory_xact_lock` sull'utente: due upload insieme non superano il limite |
| Membri di un gruppo (256) | `UPDATE chats SET member_count = member_count + $n WHERE id = $1 AND member_count + $n <= 256 RETURNING …` |
| Gruppi posseduti (50), upload in attesa (20) | conteggio dentro la transazione con `pg_advisory_xact_lock` sull'utente |
| Promozione, cambio di raggio | `SELECT … FOR UPDATE` sulla promozione; `paid_rate` dice a che prezzo è pagato il tempo in corso (stretto e riallargato non si paga due volte) |
| Promozione, evento annullato o accorciato | nella transazione del `DELETE` o del `PATCH`: righe di promozione e wallet bloccate, si restituisce il tempo non usato (`promotions.cancelled`, `dates_changed`), una volta sola e mai più di `charged - refunded` |
| Saldo | `SELECT … FOR UPDATE` sul wallet, voce di ledger nella stessa transazione |
| Accredito acquisto | `INSERT` su `store_transactions`: la chiave primaria garantisce una volta sola |
| Addebito ogni 24 ore | lavoro che prende le righe con `paid_until <= now()` e `status IN ('live', 'stopped')` con `FOR UPDATE SKIP LOCKED`: rilette sotto blocco, un rimborso nel frattempo le ha già chiuse (`promotions.tick`) |
| Doppio evento, foto o messaggio | `idempotency_keys` per gli eventi e le foto d'album (§19), `sent_messages` per i messaggi (§18). **La chiave si cerca e si scrive dentro il lock sulla persona**, nella transazione che crea: due tentativi uguali arrivati insieme (il telefono che riprova mentre il primo è ancora in viaggio) altrimenti passano entrambi il controllo. Il secondo aspetta il lock, trova la chiave e risponde con ciò che il primo ha creato |
| Connessioni (5000), blocchi (5000), eventi salvati che possono ancora avvenire (1000), eventi a cui si partecipa non finiti (200) | conteggio dentro la transazione, con `pg_advisory_xact_lock` sull'utente. Sono i limiti che tengono piccole le liste che arrivano intere e che la presenza carica in RAM |
| Username | `UNIQUE`, l'errore diventa `username_taken`; anche i nomi riservati (`RESERVED_USERNAMES`) |
| Moderazione concorrente | `SELECT … FOR UPDATE` su `chat_members` delle due persone |

**I 15 m, con il lock sulla zona.** Vale per la creazione e per il `PATCH` che sposta un evento (che esclude sé stesso):

```sql
BEGIN;
SELECT pg_advisory_xact_lock(1, hashtext($creatore::text));      -- la persona: vale anche per il massimo di 5
SELECT made_id FROM idempotency_keys WHERE user_id = $creatore AND scope = 'event' AND key = $chiave;
                                                                 -- trovata: COMMIT e rispondi con quell'evento com'è adesso (201), senza limiti né controlli
SELECT count(*) FROM events WHERE creator_id = $creatore AND cancelled_at IS NULL AND ends_at > now();
SELECT pg_advisory_xact_lock(2, hashtext($quadrato));            -- uno per quadrato toccato, in ordine
SELECT 1 FROM events WHERE ST_DWithin(location, $punto, 15) AND cancelled_at IS NULL AND ends_at > now() LIMIT 1;  -- trovato: 409 too_close
INSERT INTO events …;
INSERT INTO idempotency_keys (user_id, scope, key, made_id, at) VALUES ($creatore, 'event', $chiave, $evento, now());   -- solo se la richiesta ha la chiave
COMMIT;                                                          -- i lock si liberano qui
```

`$quadrato` è una casella da 0,01 gradi, scritta come `"<riga>:<colonna>"`, con `riga = floor((lat + 90) / 0.01)` e `colonna = floor(((lon + 180) mod 360) / 0.01)`. Sono tutte le caselle che il
cerchio di 15 m tocca, di solito una, e si bloccano sempre in ordine crescente. **Non è una frontiera**: la regola resta esatta in metri, la casella decide solo chi aspetta chi per qualche millisecondo, e una collisione di `hashtext` fa aspettare e basta.

**L'ordine dei lock evita gli stalli**: prima la persona (namespace 1), poi la zona (namespace 2). Se una transazione blocca due persone, le blocca in ordine di id. Se Postgres risponde comunque `40P01` (stallo), si ripete la transazione una volta.

### 7.4 Le letture che fanno male, e come evitarle

| Rischio | Soluzione |
|---|---|
| `GET /me/events` | ogni lista le 500 più recenti |
| `GET /chats` con molte chat | una query su `chat_members JOIN chats`, `last_message` già sulla riga, le 500 più recenti. Poi la vicinanza a lotti, solo per le dirette con non connessi |
| Membri di una chat enorme | `Chat.members` al massimo 200: proprietario, admin e chi chiede per primi (`API.md`). `memberCount` dice il totale. Per i membri semplici valgono blocchi e `sees_story` |
| Pagina evento con 50.000 partecipanti | prima le mie connessioni (`ANY`), poi `WHERE public LIMIT 200` |
| Storia di un profilo | lista unita da query per tipo, ciascuna con `LIMIT`, cursore vero al posto dell'offset di oggi |
| Tutti gli eventi di un utente | indice su `creator_id`, già limitati a un mese |
| `DELETE /me` | transazione per ciò che è suo, lavoro a lotti per messaggi e file |

### 7.5 Cache

| Cosa | Dove | Invalidazione |
|---|---|---|
| Parte pubblica degli eventi, per punto + `range` + categorie | RAM di `api`, 15 s | scadenza: i cambi arrivano già via socket |
| `UserSummary` | RAM, TTL 60 s | bus: `user.changed` |
| Blocchi e connessioni di un utente | RAM, TTL 60 s | bus: `block.*`, `connection.*` |
| Membri di una chat | RAM, TTL 30 s | bus: `chat.members.<id>` |
| Chiavi JWKS, token verificati | RAM fino a `exp` | account cancellati: `erased_accounts` e bus |

**I blocchi e la visibilità si invalidano subito e hanno un TTL corto**: una cache vecchia qui è un
problema di sicurezza, non solo di freschezza. Sulle azioni sensibili (scrivere, unirsi, connettersi) si
legge dal database.

### 7.6 Backup e guasti

WAL continuo su R2 con `pgBackRest` (RPO ≤ 1 minuto), backup completo giornaliero, una replica in
streaming su un'altra macchina, conservazione 30 giorni (riga C13 di `conservazione-dati.md`).
**Prova di ripristino ogni mese**: un backup mai ripristinato non è un backup.

| Guasto | Cosa succede | Effetto per l'utente |
|---|---|---|
| Gateway | i telefoni si riconnettono con attese casuali | ~10 s senza mappa |
| Presenza | la riserva prende il suo posto | mappa ferma per ≤ 15-20 s |
| API | il bilanciatore lo esclude | nessuno |
| NATS (cluster di 3) | i gateway si ricollegano | frame persi, recuperati alla riconnessione |
| Valkey | limiti allentati per poco | nessuno |
| Postgres primario | promozione manuale della replica | ≤ 30 minuti di sola lettura o errori |
| Una zona Hetzner | ripristino da backup altrove | ore: rischio accettato all'inizio |

Promozione **manuale** all'inizio: il failover automatico è facile da configurare male, e il rischio di
due primari è peggio di mezz'ora di fermo.

## 8. Endpoint

Tutte le rotte sono quelle di `API.md`. Qui c'è come regge ciascun gruppo.

| Gruppo | Ruolo | Traffico | Dati | Note |
|---|---|---|---|---|
| `GET /me`, `PATCH /me` | api | medio | `users` | |
| `/users/{id}`, `/activity`, `/events`, `/connections` | api | medio | Postgres + cache | **`sees_story` e blocchi a ogni lettura**, limite anti-raccolta (§20) |
| `/me/connections`, `/me/blocks` | api | basso | chiave primaria | |
| `/connections/sessions`, `/claims` | api | basso | RAM o Valkey (con più macchine), token TTL 10 s | i token vanno condivisi tra nodi |
| `GET /events` | api | **alto** | cache + PostGIS + query personale | il percorso più caldo del REST |
| `GET /events/{id}` | api | alto | evento + query personali | parte pubblica in cache |
| `POST`, `PATCH /events` | api | basso | transazione con lock sulla zona (§7.3) | |
| `PUT followers/me`, `saved/me` | api | medio | transazione | scrive anche `chat_members`. **Un evento avvenuto resta nelle liste**: uscire o togliere il segnalibro dopo è 409 `past_event` (`routes/events.py`, `took_place`); solo uno annullato prima di iniziare può uscirne (`saved_hidden`) |
| `ratings`, `photos` | api | basso | transazione | foto: `imaged`, nella stessa richiesta |
| `GET /chats` | api | **alto** | join + vicinanza a lotti | sempre con ETag |
| `GET messages` | api | alto | chiave primaria `(chat_id, seq)` | §18 |
| `POST messages` | api | **alto** | transazione + publish | §18 |
| `DELETE messages/{id}` | api | basso | transazione + `message.updated` | §18 |
| `POST read` | api | **alto** | una riga, frame `chat.read` | l'app lo manda già ritardato di 1,5 s |
| `PUT`, `DELETE /chats/{id}/picture` | api | basso | `imaged` + transazione | §19 |
| Moderazione, poll | api | basso | `SELECT … FOR UPDATE` | |
| `POST /uploads` | api | basso | limiti, firma R2, riga `uploads` | **il file non passa mai dall'API** (§19) |
| `/me/notifications` | api | medio | indice `(user_id, at DESC)` | le ultime 50. `POST …/read` arriva anche più volte di fila: con il pannello aperto l'app segna letto ciò che arriva (al più una richiesta al secondo), quindi dev'essere una scrittura da poco e senza limite proprio |
| `GET /health`, `GET /exports/{token}`, `POST /store/*` | api | basso | | **senza login**; `/store/*` verifica la firma di Apple e il `secret` di Google |
| `/promotions`, `/me/wallet*`, `/store/*` | api | basso | transazioni | |
| `DELETE /me`, `/me/export` | api + worker | raro | lavoro | |
| `/admin/*` (nuovo) | api | raro | `reports` | accesso separato, 2FA, tutto registrato |
| `/v1/ws` | gateway | **altissimo** | §4 | |

### Frame del socket

| Frame | Lo gestisce | Costo |
|---|---|---|
| `presence` | gateway → presenza | il più frequente, nessuna scrittura su disco |
| `gesture`, `connect.invite`, `connect.answer` | presenza, poi `u.<utente>` | raro |
| `broadcast` | presenza, poi `watchers` del mittente | limitato a 1 ogni 10 s |
| `ping` | gateway | |

### Effetti a catena

Una richiesta spesso cambia più cose. Tutto ciò che è su Postgres sta nella stessa transazione, e i frame partono dopo il
commit.

| Azione | Cosa deve succedere | Nel Python |
|---|---|---|
| **Blocco** | fine della connessione (`connection.removed` all'altro) e coppia in `disconnected_pairs`; **ciascuno esce dai gruppi posseduti dall'altro** (`chat.removed` a lui, `chat` agli altri), altrimenti chi blocca il proprietario continua a scrivere agli altri senza che chi modera lo veda; `chat.removed` della chat diretta a entrambi; ciascuno esce dagli eventi non finiti dell'altro; inviti in corso annullati; `events.stale` a entrambi; `relationChanged` | `routes/social.py`, `block` |
| **Sblocco** | non riconnette, la coppia resta in `disconnected_pairs`; `events.stale` a entrambi; `relationChanged` | `unblock` |
| **Disconnessione** | coppia in `disconnected_pairs`; l'altro esce dai gruppi di chi disconnette; entrambi i telefoni avvisati; `relationChanged` | `disconnect` |
| **Fine di un evento** | entro un minuto `chat.removed` ai membri online; messaggi via dopo 30 giorni, evento dopo 12 mesi | `janitor.py`, `privacy.retention_sweep` |
| **Cambio di `story_audience`** | lavoro che riscrive `event_attendees.public` | `routes/people.py` |
| **Nome, foto, avatar** | `userChanged`: il `user` riparte verso chi lo ha sulla mappa | `realtime._payload` |
| **`DELETE /me`** | tutto ciò che elenca `API.md`, `erased_accounts`, socket chiusi con 4001, `accountErased`, identità su Logto; i file a lotti, con la pulizia della CDN (§19). **Le sessioni di connessione e i loro codici muoiono subito**: un codice ancora valido creava una connessione verso un account inesistente. Chi ha gli eventi suoi sulla mappa riceve `events.stale` | `privacy.erase_user`, `realtime.forget_person` |
| **Unirsi a un evento** | `read_counter` della riga portato in pari: ciò che è stato detto si legge ma non conta come nuovo | `routes/events.py`, `follow` |
| **Il proprietario esce da un gruppo o cancella l'account** | nella stessa transazione: nuovo proprietario `ORDER BY role = 'admin' DESC, joined_at, user_id LIMIT 1`, la sua riga diventa `owner` (non è più admin né muted), messaggi di sistema nell'ordine in cui è successo (`X left`, poi `Y now runs the group`), e **chi ha un blocco con lui esce** (`chat.removed`). Nessuno rimasto: il gruppo finisce con foto e messaggi. Il nuovo proprietario può superare i 50 gruppi posseduti: non li ha creati lui | `domain.next_owner`, `hand_over`, `end_group` |
| **Annullare un evento** | la promozione finisce e il tempo non usato torna nel wallet, salvo le prime 6 ore (voce `refund`) | `promotions.cancelled` |
| **Uscire o essere tolti da una chat evento** | nessun messaggio di sistema con il nome: direbbe a tutti chi andava (nei gruppi invece sì) | `domain.leave_chat` |

### Lavori asincroni (db-scheduler)

I periodici sono `Tasks.recurring`: ne parte uno solo anche con più macchine. Ognuno dev'essere ripetibile (§6).

| Lavoro | Quando |
|---|---|
| `avatar.bake` | `PUT /me/avatar` aspetta il baker al massimo 5 s; `GET /users/{id}/avatar` non aspetta mai: risponde `mapAvatar: null` e accoda il lavoro, altrimenti chi scorre una piazza piena aspetterebbe il baker. Il Python qui è più semplice, e aspetta |
| `push.send` | a lotti, solo a chi non è connesso |
| `event.remind` | un'ora prima dell'inizio; se l'inizio si sposta riparte (`starting_notified_for`) |
| `promotion.charge` | ogni minuto: le promozioni con `paid_until <= now()` (§7.3) |
| `chat.close` | a fine evento: `chat.removed` ai membri online |
| `retention.sweep` | quotidiano, righe di `conservazione-dati.md` |
| `cleanup.sweep` | ogni minuto: upload non usati dopo 15 minuti (mai arrivati) o 1 h, file compresi (l'originale e ciò che c'è in `output_keys`, §19), `sent_messages` e `idempotency_keys` dopo 24 h, `export_tokens`, `erased_accounts` dopo 2 h, notifiche oltre 60 giorni o le 100 più recenti |
| `account.erase` | a lotti, messaggi e file |
| `attendees.set_public` | quando cambia `story_audience` |

## 9. Infrastruttura

```
                    Cloudflare (DNS, TLS, DDoS, CDN)
                 ┌──────────┴───────────┐
           api.<dominio>           cdn.<dominio>
                 │                      │
              HAProxy              R2: foto, avatar, tile
     ┌───────────┴──────────┐
  /v1/ws               resto
     │                      │
 GATEWAY ×N  ◄─ NATS ─►  API ×N ── imaged     WORKER ×N ── baker Node
     │  ▲                   │           │
 PRESENZA + riserva       Postgres ◄────┘   Valkey
                          primario + replica
                          WAL ─► R2
```

- **Macchine dedicate Hetzner** (UE): prezzo fisso, CPU e NVMe veri. Il traffico delle dedicate è da
  verificare sulla pagina d'ordine (porta da 1 Gbit/s: è il limite vero di un gateway).
- **Cloudflare R2 per i file**: nessun costo di uscita. Con foto, avatar e tile è **il risparmio più
  grande**. Su AWS S3 la banda sarebbe la voce principale della bolletta.
- **Davanti ai server, HAProxy**, su ogni macchina che riceve traffico. Fa quattro cose: termina il TLS che arriva da Cloudflare, manda `/v1/ws` ai gateway e il resto alle API, limita le
  connessioni per IP, registra **senza URL** (§3). Nel `log-format` niente `%HU` o `%HP`: solo stato, tempi e byte. I WebSocket vogliono `timeout tunnel` lungo. Con una macchina sola punta a `127.0.0.1:7777`.
- **Tra Cloudflare e il server il traffico è cifrato e autenticato**: modalità SSL *Full (strict)* con un certificato Origin CA, più *Authenticated Origin Pulls* con un certificato tuo (quello globale
  prova solo che arriva da Cloudflare, non dal tuo account). Firewall di Hetzner: la 443 solo dagli IP pubblicati da Cloudflare, tenuti aggiornati. L'IP vero del telefono è `CF-Connecting-IP`, e ci si può fidare solo per
  questo. **Questa parte non è provata**: va controllata alla prima messa in linea.
- **Rete privata** tra le macchine **con WireGuard**: NATS, Postgres e Valkey mai esposti. Il vSwitch di Hetzner da solo non cifra, e lì passano posizioni e token.
- **Rilascio**: jar e JDK copiati sulla macchina, servizio systemd riavviato, a rotazione (§21). **Niente Kubernetes**:
  su una dozzina di macchine e per una persona sola, costa più di quello che dà. Se serve, Nomad o k3s
  più avanti.
- **File caricati**: §19.
- **Asset degli avatar e CDN**: catalogo, file e map avatar serviti con `Access-Control-Allow-Origin: *`,
  `Access-Control-Expose-Headers: ETag` e supporto a `If-None-Match` (`API.md`, Avatars). Sono documenti statici, non rotte del server Java, ma l'app li chiede
  a `EXPO_PUBLIC_AVATAR_URL` con questi percorsi esatti, che la CDN deve servire: `/v1/catalog` (JSON, con ETag: l'app manda `If-None-Match`), `/v1/presets` (`{ presets }`),
  `/v1/files/<percorso>` (modelli, texture, anteprime), `/v1/map-avatars/<chiave>.glb`, `.ktx2` e `.png`, e `/v1/map-avatars/stand-in` (`{ key }`: l'avatar di riserva;
  senza, le persone sulla mappa restano invisibili finché il loro avatar non arriva).
- **Tile**: gli archivi PMTiles di `tile-provider/` vanno serviti da R2 tramite CDN, con un piccolo
  Worker per le richieste a intervallo o estraendo i singoli tile. Da decidere col loro volume.
- **Il meteo passerà dal backend** con una cache per zona (le variabili sono in `webview/shared/weatherRequest.js`: servono anche `cloud_cover_low`, `_mid`, `_high`, con cui la mappa calcola quanto cielo si vede coperto): nasconde la chiave a pagamento di Open-Meteo
  (`EXPO_PUBLIC_WEATHER_KEY` finirebbe nell'app) e riduce molto le chiamate. Oggi l'app chiama direttamente: serve una rotta
  nuova, e l'app può puntarci con `EXPO_PUBLIC_WEATHER_URL`. Va fatto prima del lancio, non prima di iniziare.

### Configurazione

| Variabile | A cosa serve |
|---|---|
| `PORT` | 7777 in sviluppo, così l'app lo trova da sola (`server.port=${PORT:7777}`). REST e socket sulla stessa porta (§5) |
| `ROLES` | come `--roles=`: `gateway,presence,api,worker`, tutti all'inizio |
| `IMAGED_URL`, `IMAGED_SECRET` | dove `api` chiama `imaged`, sulla rete privata; il segreto si confronta con `MessageDigest.isEqual` |
| `DATABASE_URL`, `NATS_URL`, `VALKEY_URL` | il primo nella forma `jdbc:postgresql://…`; gli ultimi due solo con più macchine |
| `LOGTO_ISSUER`, `LOGTO_JWKS_URL`, `LOGTO_APP_ID` | verifica dei token; l'ultimo è l'`aud` dell'ID token |
| `MIN_APP_VERSION` | sotto questa versione si risponde 426 |
| `API_RESOURCE` | `aud` richiesto. **Lo stesso valore di `EXPO_PUBLIC_API_RESOURCE` nell'app** (§13, Il token) |
| `TRUST_UNVERIFIED_TOKENS` | solo per test e prova di carico; mai in produzione |
| `PUBLIC_URL`, `ASSETS_URL` | indirizzi nelle risposte, per esempio il link di esportazione |
| `AVATAR_BAKER_URL`, `AVATAR_BAKE_SECRET`, `AVATAR_BAKE_TIMEOUT_S` | il baker degli avatar |
| `AVATAR_LIBRARY` | catalogo e `presets.json`, per validare gli avatar e sceglierne uno a chi non l'ha salvato. **Senza catalogo il server non parte**: il Python in sviluppo accetta qualsiasi avatar, e in produzione sarebbe contenuto scelto dal telefono che finisce sui telefoni degli altri |
| `AREA_HMAC_KEY` | punto d'area: stabile tra un riavvio e l'altro (§4.5). **Senza, il server non parte.** Si cambia solo se è stata compromessa (`procedura-data-breach.md`): i punti d'area cambiano una volta |
| `MAX_TRAVEL_SPEED_MPS` | position guard: 340 |
| `MAX_SHOWN` | il tetto di 25, cambiabile senza aggiornare l'app |
| `DEV_TOOLS`, `PRODUCTION` | con `PRODUCTION=1` il server non parte se la configurazione non è sicura (`config.production_problems`, più `AREA_HMAC_KEY` e `DATABASE_URL`) |
| `APPLE_BUNDLE_ID`, `APPLE_ROOT_CA`, `APPLE_ALLOW_SANDBOX` | acquisti iOS |
| `GOOGLE_PACKAGE_NAME`, `GOOGLE_SERVICE_ACCOUNT_FILE`, `GOOGLE_RTDN_SECRET`, `GOOGLE_ALLOW_TEST_PURCHASES` | acquisti Android; l'ultima solo su un server di prova, come `APPLE_ALLOW_SANDBOX`: il server non parte in produzione con una delle due accese |
| Credenziali R2 e Management API di Logto | upload e cancellazione dell'identità |

## 10. Costi

Prezzi **da riconfermare**: Hetzner è da fonti di terze parti (AX42 ~97 €/mese, AX102 ~257 €/mese,
più attivazione e IPv4) dopo gli aumenti del 2026; le pagine ufficiali che ho trovato erano vecchie.
R2 è dalla documentazione ufficiale. **Le capacità sono stime** fino alla prova di carico (§12), fatte quando il progetto era in Go: la JVM usa più memoria e più CPU. Conta poco per la RAM (un AX42 ha 64 GB: anche con
100 KB a socket, 50.000 socket sono 5 GB), di più per la CPU: **se la prova di carico chiede più macchine, la voce gateway e presenza sale**, quelle di Postgres no.

| Fase | Socket nel picco | Macchine | Stima al mese |
|---|---|---|---|
| **Lancio** (≤ 100.000 al giorno) | 8.000 | 1 AX42 con tutti i ruoli, 1 AX42 per Postgres | **~200 €** |
| **1 milione al giorno** | 80.000 | 3 gateway + presenza e riserva, 2 API + worker, 2 Postgres AX102 | **~1.100 €** |
| **10 milioni al giorno** | 800.000 | ~14 gateway, 2 presenza, 6 API + worker, 3 NATS, 4-6 Postgres | **5-7.000 €** |

**Altre voci**:

- **R2**: 0,015 $/GB al mese. Con 10.000 foto al giorno per milione di utenti, ~400 GB in più al mese:
  decine di euro il primo anno. I limiti del §19 mettono un tetto: una persona occupa al massimo circa 1,3 GB (2000 foto).
- **Logto**: il piano Free arriverebbe a 50.000 utenti attivi al mese e il Pro sarebbe a prezzo fisso, ma
  le fonti non concordano. Si può anche ospitarlo da sé (MPL-2.0). **Da controllare prima di scegliere.**
- **Push**: gratis.
- **Non incluso**: il tuo tempo e la reperibilità. Il risparmio di questa architettura si paga
  gestendo macchine e Postgres in proprio. All'inizio è sostenibile, ma con la crescita un sistemista o
  un Postgres gestito diventano la voce successiva.

## 11. Compatibilità con l'app di oggi

**Il server Java deve funzionare con l'app così com'è, senza modificarla.** Quindi, dal primo giorno:

| Regola | Perché |
|---|---|
| **Token**: in sviluppo l'app oggi manda un token **opaco**, non un JWT (§13, Il token) | senza `EXPO_PUBLIC_API_RESOURCE` Logto non emette un JWT per il backend: un server che accetta solo JWT risponde 401 a tutto |
| Su `GET /me` verifica `X-Id-Token` (firma, `iss`, `aud` = client ID dell'app, stesso `sub`; anche scaduto) e usalo solo per dare il nome a un account nuovo. In produzione ignora `X-Profile-Hint` | l'app li manda entrambi: l'hint è falsificabile |
| `X-Client: 1.0.0 (ios)` su ogni richiesta REST: sotto `MIN_APP_VERSION` rispondi 426 `upgrade_required`; senza header, servi | l'app chiede di aggiornare appena ne riceve uno |
| Non richiedere `If-Match`, `resume`. `Idempotency-Key` c'è su `POST /events` e su `POST /events/{id}/photos`, e va onorata su entrambe (§19, Cosa fa l'app) | sulle altre rotte l'app non la manda |
| Un upload già usato, nominato di nuovo: **410 `expired`**, non 400 né 409 | l'app rimanda una foto con lo stesso `uploadId`: dal 410 capisce che era stata aggiunta e rilegge l'album; con un altro stato la lascia in "non inviata" per sempre |
| Il token di connessione (QR): **da 22 a 128 caratteri di `A-Z a-z 0-9 _ -`** (16 byte o più in base64url **senza `=`**) | l'app controlla il codice letto con questa forma prima di mandarlo (`protocol.js`, `decodeQr`): un token con `=`, `+` o `/` è "non è un codice dell'app" e la connessione non parte mai |
| `mapAvatar`: **esattamente 32 cifre esadecimali minuscole**, oppure `null` | l'app mette la chiave in un indirizzo solo se ha questa forma (`avatarApi.js`): con un'altra la persona resta per sempre con l'avatar di riserva. Con `null` l'app richiede l'avatar ogni 60 s finché la persona è sulla mappa, al più 12 persone alla volta: `GET /users/{id}/avatar` dev'essere una lettura da poco |
| `uploadUrl` e l'`url` di `POST /me/export`: **HTTPS**, senza utente e password nell'indirizzo; in sviluppo va bene HTTP solo sulla stessa origine dell'API | l'app rifiuta ogni altro indirizzo (`apiConfig.js`, `safeServiceUrl`) e l'upload o l'esportazione falliscono prima di partire |
| `ready` con almeno `userId`; socket solo testo; rispondi a `ping` con `pong` | `RealtimeProvider.js` |
| `GET …/messages?before=` accetta un **id di messaggio** come cursore; se non lo trovi, la pagina più recente | `socialCache.js` conserva sul telefono un id di messaggio come cursore, e lo rimanda anche giorni dopo |
| `Poll.mine` nelle risposte a una persona, mai nei frame `message.updated` per tutta la chat | l'app conserva quello che sa; così lo stesso frame va a tutti |
| `chat`, `event`, `notification` costruiti **per ogni destinatario** | `normalizeEvent` mette `saved: false` se manca: un frame "solo parte pubblica" toglierebbe l'evento dalla lista Saved. La mia proposta precedente era sbagliata |
| Frame `event` anche a chi ha solo salvato l'evento | contratto; ora anche il Python lo fa |
| `PUT` e `POST` senza corpo (`followers/me`, `saved/me`, `/me/blocks/{id}`, `/me/export`, `notifications/read`, `/chats/{id}/pins/{messageId}`, `/chats/{id}/polls/{messageId}/close`, `/me/story/hidden/{activityId}`) | l'app li manda senza corpo e senza `Content-Type`: niente `@RequestBody` obbligatorio su quelle rotte, o rispondono 400 e 415 |
| `sponsored` e `theme` in **ogni** `EventSummary`, anche nei frame `event` | la mappa dipinge il faro da questi due: oro se `sponsored`, altrimenti `theme.beam` e `theme.beamStyle` (§16, Il tema di un evento) |
| Niente persone, eventi e messaggi demo | quelli stanno nel Python (`seed.py`): non vanno rifatti, ma con Java la mappa parte vuota. Per provare servono due telefoni o simulatori, oppure lo strumento del §12 |

**Da fare prima del lancio, insieme al server**: ID pubblici `usr_…` (solo lato server: per l'app sono opachi), notifiche
push (registrare il token, aprire la schermata giusta, `DELETE` del token all'uscita), meteo tramite il backend. Falli prima del
primo rilascio: gli ID dopo non si possono più cambiare.

**Miglioramenti facoltativi, dopo**: formato compatto dei delta, delta verso la WebView, comparsa dolce, `goaway`, rinnovo del token sul socket. Non serve
costruire `seq` e `resume`: ogni riconnessione ricarica 3-6 liste, che con gli ETag costano un 304.

## 12. Prova di carico: la prima cosa da fare

La presenza è il rischio più grosso. **Va scritta e misurata prima del resto, e sulla macchina vera, non su un portatile**: lo stesso codice su un Mac cambia di oltre 2 volte col carico e col risparmio energetico. Una
macchina Hetzner da usare per quel giorno, e un'altra per il generatore. Serve un piccolo strumento che simuli migliaia di telefoni: si connette, si autentica con token di prova, cammina con gli stessi
tempi del client. Il modello di carico misurato finora è il solo matching (§4.4, prototipo non più nel repository): la prova che manca è quella con i socket veri.

**Il limite vero sarà probabilmente la rete, non il matching.** Nella piazza da 80.000 escono 135.000 frame al secondo e circa 810 Mbit/s, e con tutti in movimento bastano 40.000 persone per arrivare a 1,4 Gbit/s: oltre la porta da 1 Gbit/s di una macchina. Scrivere quei frame su altrettanti socket costa molti più core del matching. Sono entrambe da misurare con il gateway vero, e sono il motivo per cui i gateway sono più di uno (§10).

| Scenario | Persone | Da misurare | Se fallisce |
|---|---|---|---|
| **Città** | 50.000 socket, densità normale | RAM per socket, CPU del gateway | Netty dietro la stessa interfaccia (§15) |
| **Concerto** | 50.000 in 300 m | latenza p95, byte per socket, CPU della presenza e del gateway, pause del GC | ricontrollare §4.3 |
| **Stesso punto** | 5.000 con coordinate identiche | che la presenza non rallenti | §4.5, indice |
| **Telefoni lenti** | 1.000 socket che non leggono | che chiudano con 1013 e nessun altro rallenti | §5 |
| **Riavvio gateway** | 50.000 riconnessioni | richieste/s all'API, Postgres | chiusure più lente, attese più lunghe |
| **Riavvio presenza** | 200.000 | tempo di ricostruzione | spalmare il primo matching |

**Da provare su telefoni veri**: il tetto di 25 (§4.2). Prendi il telefono più vecchio che vuoi supportare,
un iPhone e un Android economico, entra nella piazza con il pannello di sviluppo e guarda FPS, `gpu ms` e
se la WebView regge per 10 minuti. Se 25 è troppo o troppo poco, il valore si cambia sul server.

## 13. Ordine di lavoro

0. **Il progetto**: moduli, controlli del §21 già attivi e severi dal primo giorno (dopo costa molto di più), le classi `Json`, `Body`, `Text`, `Ids` del §16.
1. **Presenza e gateway, nudi** (indici, coppie, consegna, privacy, §4.10) con la prova di carico. Niente
   database: `Directory` finta e token non verificati. Si finisce quando il concerto regge.
2. **Base**: autenticazione, `users`, migrazioni, CI, e l'avvio minimo qui sotto. Da qui l'app parla con Java.
3. **Persone**: profili, connessioni, blocchi, `sees_story`, connessione di persona.
4. **Eventi**: PostGIS, cache, partecipanti, regole di concorrenza (§7.3).
5. **Chat**: messaggi, non letti, moderazione, sondaggi, offline (`after`).
6. **File e code**: upload firmati, `imaged`, db-scheduler, baker.
7. **Notifiche e push.**
8. **Denaro**: wallet, Apple, Google, rimborsi.
9. **Diritti**: `DELETE /me`, esportazione, conservazione, moderazione.
10. **Scala**: NATS al posto del bus in-process, Valkey, ruoli separati, replica, failover provato.

### Collegare l'app: l'avvio minimo

```sh
make dev NO_BACKEND=1      # server dei tile e degli avatar ed Expo, senza il Python
./gradlew :app:bootRun     # dopo il comando sopra (che libera la porta 7777): PORT=7777
```

L'app chiama `http://<computer>:7777/v1` da sola.

**Il token: va sistemato prima di tutto, o ricevi 401 ovunque.** Nei file del progetto `EXPO_PUBLIC_API_RESOURCE` non ha
nessun valore, quindi l'app riceve da Logto un token opaco, valido solo per Logto. Il Python lo accetta chiedendo a Logto chi è
(`auth.py`, `_claims_for`). Ci sono due strade, e consiglio la prima:

| | Strada | Cosa fare |
|---|---|---|
| **Consigliata** | **JWT, come in produzione** | In Logto Console crea una API resource, per esempio `https://api.<dominio>`. Avvia con `EXPO_PUBLIC_API_RESOURCE=<valore> make dev NO_BACKEND=1`, e `API_RESOURCE=<valore>` per il server Java. **Esci dall'account e rientra**: le risorse si concedono al login. Il server verifica firma, `iss`, `aud` e `exp` con la JWKS |
| Scorciatoia, solo sviluppo | Token opaco | Se `API_RESOURCE` è vuota e il token non ha la forma di un JWT, chiama `GET <LOGTO_ISSUER>/me` con quel token e tieni la risposta 10 minuti. Con `API_RESOURCE` impostata va rifiutato: 401 |

In produzione vale solo la prima (`API.md`, Conventions).

All'avvio l'app chiede queste rotte. Finché non le hai fatte davvero, queste risposte bastano per aprirla senza errori:

| Rotta | Risposta provvisoria |
|---|---|
| `GET /me` | `Me` vero: è la prima da fare |
| `GET /users/{id}/avatar` | `AvatarEntry` con `source: "preset"`, un preset da `presets.json`, `mapAvatar: null` |
| `GET /chats`, `/me/connections`, `/me/blocks` | `{ "items": [] }` |
| `GET /users/{id}`, `/activity`, `/events`, `/connections` | il profilo vero; liste vuote (`{ "items": [], "nextCursor": null }`, per le connessioni anche `total: 0, mutual: 0`) |
| `GET /me/events` | `{ "followed": [], "created": [] }` |
| `GET /events` | `{ "items": [] }` |
| `GET /me/notifications` | `{ "items": [], "unread": 0 }` |
| `GET /promotions/prices`, `GET /me/wallet` | chieste al login; un 404 qui non si vede (l'app tiene il listino di riserva e nessun portafoglio), ma la schermata Promuovi resta su "Checking your credits…" finché `/me/wallet` non risponde |
| `/v1/ws` | `auth` → `ready`; `ping` → `pong`; gli altri frame si possono ignorare |

Le rotte non ancora scritte rispondono 404 `{code, message}` e la schermata che le usa mostra un errore, senza bloccare
il resto. Ho ricavato la lista dal codice dell'app e da `API.md`, non provandola con un server Java: se all'avvio vedi
un'altra richiesta, aggiungila qui.

### I test Python come collaudo

`backend/tests` descrive il comportamento atteso. Conviene **riusarli contro il server Java** cambiando
`conftest.py`: chiamate HTTP e WebSocket vere verso un indirizzo, invece del client in-process. Da un conteggio
automatico, circa 114 funzioni di test su 223 non toccano direttamente l'interno del backend (conteggio approssimativo,
e `conftest.py` va comunque adattato). Gli altri leggono dentro il backend (`store.connect`, `presences`): servono rotte di sviluppo o vanno
riscritti. Così il Python resta utile anche dopo, come specifica eseguibile.

**Attenzione a non copiare** dal Python: le scansioni su tutto lo store, il cursore a offset, `pickle`, la
chiave casuale per processo, l'avatar accettato com'è quando manca il catalogo, e il presupposto "un solo thread,
nessuna gara" (§7.3).

## 14. Decisioni aperte

| # | Decisione | Consiglio | Perché |
|---|---|---|---|
| D2 | Limite di messaggi per chat evento molto grande | **modalità lenta automatica** sopra i 1000 membri | senza, un messaggio da moltiplicare per 50.000 esplode il fan-out e la chat è illeggibile. **Finché non decidi** vale il limite per persona: 20 ogni 10 s |
| D3 | Logto Cloud o in proprio | **Cloud** finché il prezzo regge | un componente critico in meno da gestire. **Oggi** l'app usa già Cloud |
| D4 | WebSocket attraverso Cloudflare o diretti | **Cloudflare all'inizio**, poi misurare | un solo indirizzo e protezione DDoS; da controllare limiti e condizioni con questi volumi. In sviluppo non serve |
| D5 | Push con Expo o diretto FCM/APNs | **diretto** | Expo è gratis ma ha un limite di 600 notifiche/s per progetto, e un fornitore USA in più. Cambia il token che l'app registra: va deciso quando fai il passo 7 del §13 |
| D6 | Postgres gestito o in proprio | **in proprio** con backup provati | è la scelta più economica, ed è anche quella che richiede più competenza: se non ti ci trovi, è il primo pezzo su cui spendere. Non cambia il codice |
| D7 | Messaggi di dirette e gruppi: per sempre o scadenza | **per sempre finché esiste la chat**, come dice oggi la riga C4, con archivio freddo quando serve (§18) | una scadenza dopo mesi di inattività farebbe risparmiare, ma è una promessa diversa agli utenti: va sentito il legale. Non cambia lo schema |
| D8 | Controllo automatico delle immagini (nudità, abusi su minori) | **sì prima del lancio aperto**, sentito il legale | oggi nessuno guarda le foto finché qualcuno non le segnala. `imaged` è il punto dove inserirlo, e il 422 `moderated` esiste già (§19) |

**Nessuna di queste blocca l'inizio del lavoro.**

## 15. Scelte scartate, con i numeri

### Per i vicini in movimento

Scenario: trovare i 25 più vicini entro 1 km, con tutti stipati in 300 m. Misura del 2026-11-04 in
Docker su Mac M5, 8 client, con un prototipo usa e getta. Sono **ordini di grandezza**, non capacità di
produzione: nessuna rete vera, e Redis e Tile38 non stavano ricevendo scritture durante la misura. Il client era scritto in Go, ma qui si misurano i due server, quindi il
linguaggio del backend non cambia il confronto; l'ultima colonna è in Go (in Java, §4.4).

| Persone | Servono | **Redis GEO**, capacità massima | **Tile38**, capacità massima | **R-tree dentro il processo**, core usato dal carico richiesto |
|---|---|---|---|---|
| 1.000 | 200/s | 12.200/s | 32.700/s | 0,2% |
| 5.000 | 1.000/s | 2.500/s | 29.300/s | 1,2% |
| 50.000 | **10.000/s** | **250/s: 40 volte troppo lento** | 29.500/s | ~16% |

L'ultima colonna non è confrontabile cifra per cifra con le altre due: non misura una capacità massima
ma il carico intero del §4.4, consegne comprese.

**Redis GEO**, la prima idea di tutti, e in una cosa è giusta: un servizio a parte che fa il matching è
esattamente ciò che abbiamo. Il problema è lo strumento:

1. **Non sa trovare "i più vicini" in fretta.** La documentazione dice O(N + log M), con N gli elementi
   nel rettangolo attorno al cerchio, e `COUNT` limita solo il risultato: Redis li legge e li ordina tutti.
   Nella piazza da 50.000, ogni richiesta ne tocca 50.000: è il quadratico spostato altrove. Con `ANY` è
   veloce, ma i risultati non sono i più vicini.
2. **Divide il mondo in celle anche lui**: un geohash in un sorted set, invisibile ma presente.
3. **Per crescere le frontiere arrivano davvero**: Redis Cluster divide per chiave, e una chiave per
   zona significa celle gestite a mano, con la ricerca a cavallo tra più chiavi. È proprio quello che non
   volevi.
4. **Non serve la sua forza**: condividere dati tra processi diversi. La presenza è un solo processo, e
   chiedere a un altro processo via rete costa molto più che leggere la propria memoria.

Sotto le 5.000 persone per zona funzionerebbe, ma la folla è il caso d'uso centrale dell'app. Nelle folle si potrebbe
cercare prima in un raggio piccolo e allargarlo se servono altre persone: sarebbe probabilmente molto più veloce, ma non
l'ho misurato, e restano i punti 2, 3 e 4.

**Tile38**, l'alternativa migliore: costruito per oggetti in movimento, trova davvero i più vicini, e il
tempo non dipende dalla densità. Ha anche i geofence mobili (`ROAM`) che avvisano quando due oggetti si
avvicinano. Non l'ho scelto perché fa lo stesso lavoro dell'indice nel processo, ma attraverso la rete, e non
si divide su più macchine (ha replica leader-follower, non partizione, per quanto ho trovato). I `ROAM`
mandano notifiche di continuo per chi resta vicino, e non sono provati a questa scala. Coppie, consegne e
privacy andrebbero comunque scritte da te, e la posizione reale uscirebbe dal processo. È una **buona seconda scelta**, se scrivere l'indice ti
spaventasse: ma sono poche righe attorno a una libreria.

**PostGIS per le posizioni**: non provato, perché esclude un requisito: scriverebbe le posizioni su disco, e
un indice GiST con decine di migliaia di aggiornamenti al secondo soffre.

**Celle fisse da 500 m**, la prima versione di questo documento. Non perdevano nessuno al confine, perché lo
spettatore guardava anche le celle vicine e il limite di 1 km restava esatto. Ma l'obiezione era giusta su
altri punti: tetti e velocità per cella cambiavano di colpo al bordo, l'iscrizione e il passaggio tra padroni
creavano casi limite, e serviva un filtro aggiuntivo per i blocchi e per le celle di bordo. Con il tetto di 25
persone il loro vantaggio, gli stessi byte per tutti, non serve più: ognuno riceve poco. Le coppie sono più
semplici e la frontiera sparisce.

**Query per ogni spettatore a ogni aggiornamento**: è l'N² di oggi.

### Per il resto

| Scartata | Perché |
|---|---|
| **Griglie fatte in casa per gli eventi** | PostGIS fa già la cosa giusta, e gratis |
| **Cassandra / ScyllaDB per i messaggi** | utile oltre decine di migliaia di scritture/s. Costa più macchine e competenze, e toglie le transazioni. Il partizionamento per `chat_id` tiene aperta la strada |
| **Kafka** | serve per riascoltare storie di eventi, che qui non servono. Costoso e pesante |
| **Microservizi per dominio** | §5 |
| **Kubernetes** | §9 |
| **gRPC / GraphQL verso l'app** | `API.md` spiega già il perché di REST: cache HTTP e CDN |
| **Serverless (Lambda, Cloud Run)** | i socket vivono ore, e il costo per richiesta è il contrario di quello che serve qui |
| **AWS / GCP** | ottimi, ma banda e NVMe costano molte volte di più. Hanno senso se serve un servizio che Hetzner non ha |
| **Replica globale multi-regione** | la presenza è già locale per natura. L'Europa basta per il lancio; un altro continente sarà una copia del sistema con i dati dei suoi utenti |

### Per il linguaggio e le librerie

| Scartata | Perché |
|---|---|
| **Go** | la prima scelta di questa scheda: Java è una decisione del 2026-11-04. Si paga un po' più di CPU e memoria (§4.4, §10), si guadagnano tipi più stretti (`sealed`, controlli sui null alla compilazione) e librerie più collaudate per ciò che qui è critico |
| **Netty per il gateway** | probabilmente regge più socket per macchina, ma i buffer si liberano a mano (dimenticarne uno è una perdita di memoria che si vede dopo settimane), e vuole un secondo server accanto a Spring anche in sviluppo. Storicamente usa anche `sun.misc.Unsafe`, i cui metodi di memoria dal JDK 26 sono negati di default: come si comporti la 4.2 non l'ho verificato. **È la seconda scelta**: se la prova di carico boccia Jetty, si cambia dietro `Gateway` |
| **WebFlux, programmazione reattiva** | i virtual thread permettono codice normale che blocca, senza pile di chiamate illeggibili |
| **GraalVM native image** | parte in fretta, ma qui i processi vivono settimane, e la riflessione va configurata a mano: una fonte in più di errori che si vedono solo in produzione |
| **Hibernate, JPA** | caricamenti nascosti, N+1, scritture implicite: qui il progetto è il suo SQL (§7) |
| **Lombok** | si infila nel compilatore; i `record` fanno già il grosso |
| **Log4j 2** | Logback è il predefinito di Spring Boot: un'altra libreria di log non aggiunge niente |
| **Spring Security** | qui l'autenticazione è verificare un token Bearer con Nimbus: un filtro di poche decine di righe, con un test che prova tutte le rotte (§21). Spring Security aggiungerebbe una catena di configurazioni per funzioni che non si usano. Se un giorno servissero, si aggiunge |
| **libvips dentro la JVM** (`vips-ffm`, JNI) | un crash del codice C abbatterebbe socket e API (§19) |
| **`SERIALIZABLE` per i 15 m** | provato, non basta (§7.3) |
| **`uuidv7()` di Postgres** | 62 bit casuali (§7.2) |
| **KD-tree di `tinspin-indexes`** | nel collaudo con persone nello stesso punto è andato in `StackOverflowError` (con lo stack ridotto a 512 KB: scende in ricorsione col numero di doppioni), e con un GPS finto si può provocare apposta |
| **Quadtree e R*Tree di `tinspin-indexes`** | esatti e veloci nella prova normale, ma con 20.000 persone nello stesso punto molte decine di volte più lenti del PH-Tree: un punto debole che un attaccante può scegliere. Restano un ripiego dietro `NearIndex` |
| **`rtree2`** | immutabile, quindi ogni spostamento ricostruisce parte dell'albero: non ha finito in 5 minuti la prova da 50.000 persone. Ultima versione del 2022 |

## 16. Trappole di Java rispetto a questo contratto

Quasi ognuna di queste è stata **vista succedere** nelle prove del §22, su un Jackson, un Jetty e uno Spring Boot veri.

| Trappola | Cosa succede | Cosa fare |
|---|---|---|
| **Jackson accetta troppo** | di default `8.5` diventa l'intero `8`, `"8"` diventa `8`, `42` la stringa `"42"`, `1` diventa `true`, `1e999` Infinity, `"NaN"` NaN | i corpi si leggono da `JsonNode` con `Body` (sotto), mai legati direttamente a un record. `API.md`: tipo sbagliato è 400, mai 500 |
| **`Instant` perde gli zeri** | `18:00:00Z` invece di `18:00:00.000Z`, e `.123456Z` con i microsecondi di Postgres | `Json.MAPPER`, sotto: formato fisso con millisecondi |
| **NUL e caratteri spezzati** | `\u0000` manda Postgres in errore (sarebbe un 500), un surrogato spaiato viene salvato **in silenzio** come `?` | `Body.string`, sotto |
| **Lunghezze** | `"😀".length()` è 2, e `substring` spezza l'emoji | `Text.length`, `Text.cut`: i limiti (`title` 1-50, `text` ≤ 1000) contano i caratteri, **dopo** `Text.plain` |
| **`strip()` e `trim()`** | lasciano lo spazio unificatore: un titolo fatto solo di ` ` passerebbe come non vuoto | `Text.strip`, identico al Python su tutti i caratteri Unicode (provato) |
| **Regex** | `\s` vede solo gli spazi ASCII; `$` con `find()` accetta un "a capo" in fondo (`"sara\n"`) | sempre `matches()`, e `UNICODE_CHARACTER_CLASS` dove c'è `\s`. Prima la lunghezza massima, poi la regex: un `(a\|b)*` su un testo lungo può dare `StackOverflowError` |
| **Numeri nella query** | `Double.parseDouble` accetta `NaN`, `Infinity`, `0x1p3`, `1.5f` e gli spazi; `Integer.parseInt` le cifre arabe. Anche `@RequestParam double` | si leggono come `String`, si controlla con `[-+]?\d+(\.\d+)?([eE][-+]?\d+)?` su cifre ASCII. Poi `!(lat >= -90 && lat <= 90)`: scritto come `lat < -90 \|\| lat > 90` lascia passare NaN |
| **Date in arrivo** | un numero diventa una data; il Python accetta anche la sola data | si leggono come `String` con `OffsetDateTime.parse`: accetta `Z` e `+02:00`, rifiuta il resto. L'app manda sempre la forma completa |
| **Lingua del server** | `"TITLE".toLowerCase()` in turco dà `tıtle`, `String.format("%.2f")` in italiano `1,50` | sempre `Locale.ROOT` |
| **`UUID.fromString`** | accetta `1-1-1-1-1` | `Ids.parse`, sotto. Malformato: 404 come tutto ciò che non esiste |
| **Il `typ` dei token** | Nimbus rifiuta `typ: at+jwt`, il tipo che lo standard dei JWT di accesso (RFC 9068) impone: **401 a tutto** | `Tokens`, sotto. Non ho un token vero di Logto per confermare che tipo usi: la configurazione accetta entrambi |
| **ID token scaduto** | il verificatore normale lo rifiuta, ma `API.md` lo vuole valido | verificatore a parte, solo per `X-Id-Token`, sotto |
| **Errori di Jetty** | `%2F`, `%00`, `..`, intestazione enorme, HTTP non valido: pagina HTML, prima ancora di arrivare a Spring | `server.setErrorHandler` con un `ErrorHandler` che sovrascrive `generateResponse` e scrive `{code, message}` (§5) |
| **Errori di Spring** | 404, 405, 415 e JSON rotto hanno un loro formato; ciò che esce da un filtro salta `@RestControllerAdvice` | un advice che estende `ResponseEntityExceptionHandler` e sovrascrive `handleExceptionInternal`, più `@ExceptionHandler(Exception.class)` → 500 `internal` senza dettagli. `spring.mvc.problemdetails.enabled=false`, tutti gli `server.error.include-*` a `never`. Nei filtri, la risposta si scrive a mano |
| **Corpi** | Jetty non controlla la dimensione di un JSON | un filtro come `main.py`, `guard`: 411 se a pezzi senza `Content-Length`, 413 oltre 256 KB. Provato. Dietro Cloudflare va controllato che la lunghezza arrivi |
| **ETag** | il filtro pronto di Spring (`ShallowEtagHeaderFilter`) di suo fa ETag forti e non mette il `Cache-Control` del contratto | un filtro come `main.py`, `etags`: ogni `200` JSON di una GET, `W/"…"`, `Cache-Control: private, no-cache`, 304 senza corpo, niente dove c'è `no-store`. Jetty aggiunge `--gzip` all'ETag quando comprime e lo capisce quando torna: provato, per l'app è opaco |
| **Ordine dei campi** | `Map.of` cambia ordine da una JVM all'altra: stesso contenuto, ETag diverso su ogni macchina | `ORDER_MAP_ENTRIES_BY_KEYS` in `Json.MAPPER`; per le risposte, `record` |
| **Null nelle risposte** | i campi nullable devono esserci con `null`, solo quelli con `?` in `API.md` possono mancare, le liste non sono mai `null` | `Include.ALWAYS` in `Json.MAPPER`; `List.of()` come valore iniziale. Controllato da NullAway (§21) |
| **`PATCH`** | assente e `null` sono diversi (`links: null` cancella) | `Body.has(campo)` |
| **`@Transactional`** | ignorato se il metodo chiama un altro metodo della stessa classe; non annulla sulle eccezioni controllate | vietato: `TransactionTemplate`, che si legge e si testa. ArchUnit lo impedisce (§21) |
| **Rete dentro una transazione** | R2, `imaged`, Logto, Apple con una connessione al database in mano: il pool si svuota e cade tutto | prima la rete, poi la transazione. I frame e i lavori partono dopo il commit |
| **Virtual thread senza limiti** | diecimila richieste aspettano tutte `imaged` o il pool | `Semaphore` davanti alle risorse scarse; `connectionTimeout` di HikariCP a 2 s, poi 503 `unavailable` con `Retry-After` |
| **`toString()` dei record** | stampa tutto: coordinate, token, testi, finiti in un log o in un messaggio d'errore | `Point`, `Token` e i frame sovrascrivono `toString()`. Un test lo controlla. Non si logga mai un oggetto intero |
| **Denaro** | `int * int` oltre il limite dà un numero sbagliato senza errore, `0.1 + 0.2` non fa 0,3 | crediti in `int`, conti in `long`, `Math.multiplyExact`, `Math.ceilDiv`, `Math.floorDiv`. Mai `double`. I rimborsi si arrotondano per difetto come `promotions.py` |
| **Serializzazione Java** | `ObjectInputStream` è la via classica per eseguire codice da remoto | vietata, ed è il formato predefinito di db-scheduler: JSON al suo posto (§6). Niente "default typing" di Jackson |
| **Casuali** | `Random` e `ThreadLocalRandom` si possono prevedere | `SecureRandom` per id, token, codici. Confronti di segreti con `MessageDigest.isEqual` |
| **`javax.crypto.Mac`** | non si può condividere tra thread | uno nuovo a ogni uso, o uno dentro il thread della presenza |
| **Riusare gli array delle chiavi** | il PH-Tree può tenerli: cambiarli dopo rompe l'indice | un array nuovo a ogni inserimento |
| **`computeIfAbsent`** | con I/O dentro blocca altri thread; `HashMap` condivisa si corrompe | niente I/O dentro; le mappe o sono del solo thread della presenza o sono concorrenti |
| **Eccezioni fuori dal giro** | un `OutOfMemoryError` a metà lascia il processo vivo e rotto | `-XX:+ExitOnOutOfMemoryError` (§21): meglio ripartire |
| **Frame binari** | l'app li riceve come blob | scrivi sempre frame di testo. Uno in arrivo non è un errore del server: prima di `auth` chiusura 4001, dopo `error` `bad_request`, e conta per il limite di 10 al secondo |
| **Handle di un account nuovo** | | da `username` o `name` dell'ID token, mai dall'email: `Text.handle`, sotto, poi il controllo dei nomi riservati (`RESERVED_USERNAMES`, `store.free_username`); sotto i 3 caratteri o senza equivalente ASCII (`Алиса`), `user` e cifre casuali |
| **Testo non ripulito** | | `Text.plain` *prima* di contare i caratteri, e tratta come vuoto ciò che resta vuoto (`API.md`, Text) |

### Le classi da scrivere per prime

Tutte compilate e provate con le versioni di Spring Boot 4.1.2 (Jackson 3.1.7). `Text` è stato confrontato con il Python su tutti i caratteri Unicode e su handle, nomi, date e distanze: nessuna differenza. Stanno in `core`, ognuna con i suoi test.

```java
public final class Json {
    static final DateTimeFormatter TIME =
            DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    /** Uno solo, esposto anche come bean: Spring e gateway usano lo stesso. */
    public static final JsonMapper MAPPER = JsonMapper.builder(JsonFactory.builder()
                    .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .streamReadConstraints(StreamReadConstraints.builder()
                            .maxNestingDepth(64).maxStringLength(1 << 20).maxNumberLength(64).build())
                    .build())
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .enable(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
            .changeDefaultPropertyInclusion(v -> v.withValueInclusion(JsonInclude.Include.ALWAYS))
            .addModule(new SimpleModule().addSerializer(Instant.class, new ValueSerializer<Instant>() {
                @Override
                public void serialize(Instant value, JsonGenerator out, SerializationContext context) {
                    out.writeString(TIME.format(value));
                }
            }))
            .build();
}

/** Il corpo di una richiesta: tipi stretti in un punto solo. BadRequest diventa 400. */
public final class Body {
    private final JsonNode node;

    public static Body of(JsonNode node) {        // @RequestBody(required = false) JsonNode
        if (node == null || node.isNull()) return new Body(Json.MAPPER.createObjectNode());
        if (!node.isObject()) throw new BadRequest("a JSON object is needed");
        return new Body(node);
    }
    private Body(JsonNode node) { this.node = node; }

    public boolean has(String field) { return node.has(field); }   // PATCH: assente o null

    public String string(String field) {          // null se assente o null
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        if (!v.isString()) throw new BadRequest(field + ": a string is needed");
        String s = v.stringValue();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) i++;
            else if (Character.isSurrogate(c)) throw new BadRequest(field + ": invalid text");
        }
        return s.indexOf('\0') >= 0 ? s.replace("\0", "") : s;
    }
    public Integer integer(String field) {        // 8.0, "8", true e 99999999999 sono 400
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        if (!v.isIntegralNumber() || !v.canConvertToInt()) throw new BadRequest(field + ": an integer is needed");
        return v.intValue();
    }
    public Double number(String field) {          // 1e999 e "8" sono 400
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        if (!v.isNumber() || !Double.isFinite(v.doubleValue())) throw new BadRequest(field + ": a number is needed");
        return v.doubleValue();
    }
    public Boolean bool(String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        if (!v.isBoolean()) throw new BadRequest(field + ": true or false is needed");
        return v.booleanValue();
    }
}

public final class Text {
    static final Pattern HIDDEN = Pattern.compile(
        "[\\x{0}-\\x{8}\\x{b}\\x{c}\\x{e}-\\x{1f}\\x{7f}-\\x{9f}\\x{200b}\\x{200e}\\x{200f}\\x{202a}-\\x{202e}\\x{2060}\\x{2066}-\\x{2069}\\x{feff}]");

    public static String plain(String s) { return HIDDEN.matcher(s).replaceAll(""); }   // API.md, Text
    public static int length(String s) { return s.codePointCount(0, s.length()); }
    public static String cut(String s, int max) {
        return length(s) <= max ? s : s.substring(0, s.offsetByCodePoints(0, max));
    }
    static boolean space(int c) { return Character.isWhitespace(c) || Character.isSpaceChar(c) || c == 0x85; }

    public static String strip(String s) {        // come str.strip() in Python
        int a = 0, b = s.length();
        while (a < b && space(s.codePointAt(a))) a += Character.charCount(s.codePointAt(a));
        while (b > a && space(s.codePointBefore(b))) b -= Character.charCount(s.codePointBefore(b));
        return s.substring(a, b);
    }
    public static String words(String s) {        // come " ".join(s.split()) in Python
        StringBuilder out = new StringBuilder();
        boolean gap = false;
        for (int i = 0; i < s.length(); ) {
            int c = s.codePointAt(i);
            i += Character.charCount(c);
            if (space(c)) { gap = out.length() > 0; }
            else { if (gap) out.append(' '); gap = false; out.appendCodePoint(c); }
        }
        return out.toString();
    }
    public static String handle(String text) {    // auth._handle_from; "" se non ne esce uno valido
        String plain = Normalizer.normalize(text == null ? "" : text, Normalizer.Form.NFKD)
                .replaceAll("[^\\x00-\\x7f]", "").toLowerCase(Locale.ROOT);
        StringBuilder kept = new StringBuilder();
        plain.chars().filter(x -> (x >= 'a' && x <= 'z') || (x >= '0' && x <= '9') || x == '.' || x == '_')
                .forEach(kept::appendCodePoint);
        String s = kept.toString().replaceAll("\\.{2,}", ".");
        if (s.length() > 30) s = s.substring(0, 30);
        s = s.replaceAll("^[._]+", "").replaceAll("[._]+$", "");
        return s.length() >= 3 ? s : "";
    }
}

public final class Ids {
    static final SecureRandom RANDOM = new SecureRandom();
    static final Pattern BODY = Pattern.compile("[A-Za-z0-9_-]{22}");

    public static UUID next() {                   // versione 7: 48 bit di tempo, 74 casuali
        byte[] b = new byte[16];
        RANDOM.nextBytes(b);
        long ms = System.currentTimeMillis();
        for (int i = 0; i < 6; i++) b[i] = (byte) (ms >>> (40 - 8 * i));
        b[6] = (byte) ((b[6] & 0x0f) | 0x70);
        b[8] = (byte) ((b[8] & 0x3f) | 0x80);
        ByteBuffer x = ByteBuffer.wrap(b);
        return new UUID(x.getLong(), x.getLong());
    }
    public static String publicId(String prefix, UUID id) {
        byte[] b = ByteBuffer.allocate(16).putLong(id.getMostSignificantBits()).putLong(id.getLeastSignificantBits()).array();
        return prefix + "_" + Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }
    public static Optional<UUID> parse(String prefix, String s) {   // vuoto: 404
        if (s == null || !s.startsWith(prefix + "_")) return Optional.empty();
        String body = s.substring(prefix.length() + 1);
        if (!BODY.matcher(body).matches()) return Optional.empty();
        ByteBuffer x;
        try {
            x = ByteBuffer.wrap(Base64.getUrlDecoder().decode(body));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
        UUID id = new UUID(x.getLong(), x.getLong());
        return publicId(prefix, id).equals(s) ? Optional.of(id) : Optional.empty();   // solo la forma canonica
    }
}

public final class Tokens {
    static final Set<JWSAlgorithm> ALGS = Set.of(JWSAlgorithm.ES384, JWSAlgorithm.ES256, JWSAlgorithm.RS256);

    static DefaultJWTProcessor<SecurityContext> accessTokens(URL jwks, String issuer, String audience) {
        JWKSource<SecurityContext> keys = JWKSourceBuilder.<SecurityContext>create(jwks)
                .cache(3_600_000, 15_000).rateLimited(30_000).refreshAheadCache(true)
                .outageTolerant(6 * 3_600_000).retrying(true).build();
        var p = new DefaultJWTProcessor<SecurityContext>();
        p.setJWSKeySelector(new JWSVerificationKeySelector<>(ALGS, keys));
        p.setJWSTypeVerifier(new DefaultJOSEObjectTypeVerifier<>(new JOSEObjectType("at+jwt"), JOSEObjectType.JWT, null));
        p.setJWTClaimsSetVerifier(new DefaultJWTClaimsVerifier<>(audience,
                new JWTClaimsSet.Builder().issuer(issuer).build(), Set.of("sub", "exp", "iat")));   // un minuto di tolleranza
        return p;
    }
    static DefaultJWTProcessor<SecurityContext> idTokens(JWKSource<SecurityContext> keys, String issuer, String appId) {
        var p = new DefaultJWTProcessor<SecurityContext>();
        p.setJWSKeySelector(new JWSVerificationKeySelector<>(ALGS, keys));
        p.setJWTClaimsSetVerifier((c, ctx) -> {           // anche scaduto: dice solo chi ha fatto il login
            if (!issuer.equals(c.getIssuer()) || !c.getAudience().contains(appId) || c.getSubject() == null) throw new BadJWTException("id token");
        });
        return p;
    }
}
```

**Provato su `Tokens`**: passano solo i token validi, e quelli scaduti da meno di un minuto. Rifiutati: emittente o `aud` sbagliati, senza `exp` o `sub`, `alg: none`, HS256 firmato con la chiave pubblica come segreto, RS512,
`kid` sconosciuto, stesso `kid` con un'altra chiave, contenuto modificato. La cache verificata dei token si tiene per **hash** del token, fino a `exp`, e si controlla sempre `erased_accounts` (`auth._check_not_erased`).

**Da non copiare nemmeno in Java** il modo in cui `auth._claims_for` accetta un token non verificato quando `TRUST_UNVERIFIED_TOKENS` è attivo: solo per test e prova di carico, e con `PRODUCTION=1` il server non parte (§21).

### Chi è andato a un evento

`sees_story` vale anche dove è facile dimenticarlo: `Photo.author` e `Rating.user` sono `null` per chi non può saperlo (mai per
l'autore e per l'organizzatore), e le notifiche `album.photos` non lo nominano. Il Python nominava gli autori delle foto a
chiunque: corretto il 2026-11-05, con `test_a_photo_does_not_say_who_went_to_who_may_not_know`. La foto e il voto restano e contano.

### Il tema di un evento

`Event.theme` è il vestito che l'organizzatore sceglie nel foglio "Style": sta in `jsonb`, ma **la sua forma la decide il
server**. Non salvare il JSON ricevuto così com'è.

| Regola | Perché |
|---|---|
| Sei campi, sempre tutti nelle risposte: `color`, `beam`, `beamStyle`, `emoji`, `background`, `title`; `null` è "nessun tema" | l'app li legge con `cleanTheme` |
| **Ogni scrittura sostituisce tutto il tema**: un campo assente o `null` torna al suo valore base, i campi sconosciuti spariscono. Non è una fusione col tema vecchio | l'app manda sempre il tema intero; "togliere" un colore vuol dire non mandarlo |
| `color` e `beam` si controllano come `#RRGGBB` e **si conservano come sono arrivati**. Mai maiuscole o minuscole | l'app confronta il valore esatto con le sue liste: normalizzarlo farebbe sembrare "non scelto" un colore scelto |
| Niente elenco dei colori permessi sul server | le liste stanno nell'app: un colore nuovo non deve aspettare il server, e un valore sconosciuto l'app lo tratta come "automatico" |
| **L'oro non è un colore del tema**: `sponsored` lo decide il server, e l'app dipinge d'oro il faro di un evento sponsorizzato qualunque sia `beam`. Non scrivere l'oro in `beam` e non cancellare `beam` quando parte una promozione | quando la promozione finisce, torna il colore scelto. Nessun valore di `beam` può far sembrare pagato un evento: l'app non mostra mai l'oro da `beam` |
| `beamStyle`: `beam`, `pulse`, `helix`, `stardust`, `veil`; altro è 400. Vale anche per gli sponsorizzati | li disegna tutti la mappa (`eventBeacons.js`): al server non costano nulla |
| `emoji` è un simbolo: al massimo 16 caratteri e nessuna lettera o cifra | si vede sulla mappa e nelle liste: non deve diventare una scritta |
| Dopo la fine o l'annullamento anche il tema è 410 `gone`, come ogni `PATCH`; gli eventi flash lo hanno come gli altri | ciò che è avvenuto resta com'era; l'app toglie "Style" appena l'evento finisce |
| Cambiare solo il tema: frame `event` e `modifiedDate` sì, notifica `event.changed` no. Conta nel limite `event-edit` (120 l'ora) | `event.changed` è per un nuovo orario o luogo: nessuno va avvisato per un colore |

Il tema è **pubblico**: sta nella parte in cache di `GET /events` (§4) e nelle chat degli eventi. Una modifica si vede entro i
15 s della cache in lista, e subito nel frame `event`. Provata come dice il §22.

```java
/** Event.theme: forma fissa e valori noti. Si scrive in jsonb così, mai il JSON ricevuto. */
public record EventTheme(String color, String beam, String beamStyle, String emoji, String background, String title) {
    static final Pattern HEX = Pattern.compile("#[0-9A-Fa-f]{6}");
    static final Set<String> BEAM_STYLES = Set.of("beam", "pulse", "helix", "stardust", "veil");
    static final Set<String> BACKGROUNDS = Set.of("plain", "glow", "tint", "aurora", "pattern");
    static final Set<String> TITLES = Set.of("classic", "bold", "serif", "mono");

    /** null se il tema è null; BadRequest per un valore non valido. */
    public static EventTheme of(JsonNode value) {
        if (value == null || value.isNull()) return null;
        if (!value.isObject()) throw new BadRequest("theme: an object or null");
        Body body = Body.of(value);
        String emoji = body.string("emoji");
        if (emoji != null) {
            emoji = Text.plain(emoji);
            if (Text.length(emoji) > 16 || emoji.codePoints().anyMatch(Character::isLetterOrDigit)) {
                throw new BadRequest("theme.emoji: one emoji");
            }
        }
        return new EventTheme(hex(body, "color"), hex(body, "beam"),
                oneOf(body, "beamStyle", BEAM_STYLES, "beam"), emoji,
                oneOf(body, "background", BACKGROUNDS, "plain"), oneOf(body, "title", TITLES, "classic"));
    }
    private static String hex(Body body, String field) {
        String value = body.string(field);        // così com'è arrivato
        if (value != null && !HEX.matcher(value).matches()) throw new BadRequest("theme." + field + ": #RRGGBB");
        return value;
    }
    private static String oneOf(Body body, String field, Set<String> allowed, String otherwise) {
        String value = body.string(field);
        if (value == null) return otherwise;
        if (!allowed.contains(value)) throw new BadRequest("theme." + field + ": one of " + new TreeSet<>(allowed));
        return value;
    }
}
```

### Il contratto si controlla da solo

`backend/tests/test_contract_docs.py` confronta rotte, codici d'errore, limiti (con i numeri) e valori permessi tra il server,
`API.md` e l'app: una cosa cambiata da una parte sola fa fallire `make test`. Quando esiste il server Java, fai la stessa
cosa contro di lui, leggendo le sue rotte da OpenAPI o da una richiesta per rotta: è il modo più economico di restare in simbiosi.

## 17. Dove trovare ogni regola

In caso di dubbio vince `API.md`; il comportamento di riferimento è in `backend/app`.

| Argomento | File |
|---|---|
| Socket, presenza, gesti, inviti | `realtime.py`, `position_guard.py` |
| Eventi, album, upload | `routes/events.py`, `media.py`, `domain.py` (`notify_event`) |
| Tema di un evento e faro | §16, `routes/events.py` (`_theme`); nell'app `eventTheme.js` (liste) e `eventBeacons.js` (come appare, l'oro) |
| Chat e moderazione | `routes/chats.py`, `domain.py`, `moderation.py`, `views.py` (`sees_message`), test in `test_group_pictures_and_messages.py` |
| Upload e limiti | `media.py`, `routes/events.py` (`_check_photo_room`), `limits.py`, test in `test_uploads_and_quotas.py` |
| Persone, storia, connessioni | `routes/people.py`, `routes/social.py`, `docs/CONNECT-PROTOCOL.md` |
| Notifiche, lavori periodici | `notifications.py`, `janitor.py` |
| Denaro | `promotions.py`, `stores.py`, `PROMOTIONS.md` |
| Account, privacy, conservazione | `auth.py`, `privacy.py` (`erase_user`, e i campi della copia dei dati di `/exports`), `legal/it/compliance/conservazione-dati.md` |
| Avatar | `avatars.py`, `avatar-server/shared/avatarFormat.js` (la validazione va riscritta in Java) |

## 18. Messaggistica: come farla reggere per anni

**L'idea**: Postgres è la verità, il socket è solo un avviso. Il telefono si rimette in pari da solo con `after`, quindi un
frame perso non è mai un messaggio perso. Tutto il resto segue da qui.

### Le garanzie, e chi le dà

| Garanzia | Come |
|---|---|
| **Un messaggio confermato non si perde** | `201` solo dopo il commit; WAL su R2 (§7.6) |
| **Mai due volte** | `clientId` + `sent_messages`; il telefono riconosce il suo con `clientId` |
| **Stesso ordine per tutti** | `seq` per chat, assegnato dal database; il telefono ordina per `at` del server, sempre crescente nella chat |
| **Nessun buco dopo l'offline** | `?after=<messageId>` scorre `seq`; se la pagina più recente non arriva a ciò che il telefono ha, l'app riempie il buco (`fillGap`) |
| **Consegna live al massimo una volta** | frame su NATS core; ciò che manca lo recupera il telefono a ogni `ready` e ritorno in primo piano |
| **Ordine di invio dal telefono** | l'app manda un messaggio alla volta, e quelli che non possono partire aspettano in coda (outbox) |

### Scrivere un messaggio

```
POST /chats/{id}/messages { text, clientId }
 1. token e appartenenza alla chat (404 se non ci sei)
 2. clientId già visto (sent_messages): rispondi con quel messaggio. PRIMA delle regole: era
    permesso quando è stato scritto, anche se ora l'altro si è allontanato o la chat è read-only
 3. regole: canWrite (diretta: connessi, o vicini e mai disconnessi; gruppo o evento: muted, read-only)
 4. testo ripulito (API.md, Text), 1-1000 caratteri; limite 20 ogni 10 s per persona
 5. transazione:
      UPDATE chats SET seq = seq + 1, counter = counter + 1, last_at = GREATEST(now(), last_at + 1 ms),
                       last_message = $json WHERE id = $chat RETURNING seq, counter, last_at
      INSERT INTO messages …
      INSERT INTO sent_messages … ON CONFLICT DO NOTHING
        (nessuna riga inserita = due invii insieme: annulla e rispondi con quello già salvato)
      UPDATE chat_members SET read_counter = $counter, read_at = $at WHERE chat, mittente
      lavoro push (solo se ha senso, sotto)
 6. dopo il commit: publish del frame { message, author }
 7. 201 Message
```

Il `seq` e il contatore stanno sulla riga della chat: l'`UPDATE` fa da coda per quella chat, e due messaggi della stessa chat non
possono prendere lo stesso numero. Chat diverse non si disturbano mai. Metti `fillfactor = 70` su `chats` e **non indicizzare
`last_at` né `last_message`**, così gli aggiornamenti restano HOT e non toccano gli indici.

I messaggi di sistema (qualcuno è uscito, foto cambiata) passano dalla stessa strada, ma non incrementano `counter`.

### Leggere

```sql
-- pagina più vecchia: before è un ID di messaggio (l'app lo conserva sul telefono)
SELECT … FROM messages
 WHERE chat_id = $1 AND seq < (SELECT seq FROM messages WHERE chat_id = $1 AND id = $before)
   AND seq >= $joined_seq                    -- gruppi: solo da quando è entrato
   AND sender <> ALL($bloccati)              -- blocchi nei due versi
 ORDER BY seq DESC LIMIT 50;
```

- Il risultato si restituisce dal più vecchio al più nuovo. `nextCursor` è l'id del primo messaggio della pagina, oppure `null`
  quando prima non c'è più niente che l'utente possa vedere.
- `after`: `seq > …  ORDER BY seq ASC`; id sconosciuto: 404, e l'app riparte dalla pagina più recente.
- Un nuovo membro di un gruppo vede dal `joined_seq` in poi; chi esce e rientra riparte dal nuovo `joined_seq`. Si prende dalla stessa istruzione che blocca la riga della chat (`UPDATE chats SET member_count = … RETURNING seq + 1`), così nessun messaggio può passare in mezzo. **Mai confrontando gli orari**: il Python lo fa, e un messaggio caduto nello stesso millisecondo dell'ingresso diventava leggibile (un test instabile l'ha mostrato, corretto il 2026-11-05). Le chat evento
  mostrano tutta la storia a chi entra.
- La stessa regola (`sees_message`) vale per l'ultimo messaggio, i non letti, i messaggi fissati, i sondaggi e `message.updated`.
  Se `last_message` sulla riga è di qualcuno che chi legge ha bloccato, quella chat si ricalcola nel percorso lento.

### Non letti

**Niente contatori per membro**: la chat ha `counter`, ogni membro `read_counter`, e i non letti sono la differenza. Con 50.000
membri, un messaggio fa una scrittura, non 50.000.

- Mandare un messaggio azzera i propri non letti. `POST /read` non torna mai indietro (`GREATEST`) e manda `chat.read` ai
  dispositivi dell'utente.
- Chi ha bloccato qualcuno presente in quella chat, e solo lui, passa dal percorso lento: conta `seq > letto AND sender <> ALL(bloccati)`,
  fermandosi a 100. L'app mostra comunque un numero e basta.
- Un messaggio cancellato con l'account dell'autore può lasciare il contatore alto di qualche unità: si corregge alla prima
  lettura. È accettabile, e correggerlo su tutti i membri costerebbe proprio la scrittura che qui si evita.

### Consegna

| Chat | Come | Note |
|---|---|---|
| Diretta, gruppo (≤ 256) | un frame per ogni membro online su `u.<utente>`, tranne chi ha un blocco col mittente | il numero è limitato dalla dimensione del gruppo |
| Evento fino a 200 | come sopra | |
| Evento grande (`large`) | un frame su `c.<chat>`, una copia per gateway, con la lista di chi ha un blocco col mittente; il gateway non lo consegna a loro | |

Ogni socket ha una coda limitata (500): chi non legge viene chiuso con 1013 e si rimette in pari da solo, non rallenta gli altri.

**`message.updated` nelle chat grandi**: un sondaggio con migliaia di voti non manda un frame per voto. Si raccoglie al massimo
un frame al secondo per messaggio, con lo stato finale; `Poll` contiene solo i conteggi, quindi non cresce.

**Push** (quando arriveranno, §14 D5): solo a chi non ha un socket, rispettando `notifyMessages`, mai da chi è bloccato. Uno per chat
ogni 30 s con il conteggio, non uno per messaggio: `scheduleIfNotExists("push:<chat>", now + 30 s)` fa una riga sola in coda per chat, quindi anche la coda non cresce coi messaggi. Nelle chat evento solo i messaggi di organizzatore e admin: in una chat da
5000 persone il resto è rumore, e costa.

### Cancellare

- **Un messaggio**: l'autore, o chi ha un ruolo più alto (`DELETE /chats/{id}/messages/{messageId}`). Si svuota il testo e si toglie il sondaggio
  **nella riga**, con `deleted_at`: il testo sparisce davvero, il posto resta, così `seq` e i cursori non cambiano. Se era fissato si sfissa. Va a tutti con
  `message.updated`, e il telefono lo sostituisce con "Message removed". La copia per la moderazione esiste solo se qualcuno l'ha segnalato
  (`reports.snapshot`).
  Limite noto: un telefono offline che ha il messaggio in una pagina vecchia lo tiene finché non scorre fino a lì.
- **Account cancellato**: i suoi messaggi escono a lotti con `INDEX (sender)`, e `last_message` si ricalcola per le chat toccate. Chat dirette e gruppi
  suoi spariscono per tutti (`privacy.erase_user`).
- **Chat evento**: **30 giorni esatti dopo la fine** (riga C4-bis), con un lavoro che cancella a lotti per `chat_id`. Niente partizioni mensili: un
  evento può iniziare 31 giorni dopo la creazione e durare altri 31, quindi i messaggi resterebbero mesi oltre il dovuto; inoltre Postgres non accetta un
  vincolo unico su `client_id` senza la chiave di partizione.

### La crescita nel tempo

A 1 milione di utenti al giorno, con 20 messaggi a testa: 20 milioni al giorno, circa 6 GB al giorno tra righe e indici (stima, ~300 byte a
messaggio), **circa 2 TB l'anno**. A 10 milioni, 20 TB l'anno. Il piano, per passi, ognuno solo quando serve:

| Quando | Cosa | Perché funziona senza riscrivere |
|---|---|---|
| Dal primo giorno | `PARTITION BY HASH (chat_id)` con **64 partizioni** | aggiungerle dopo è costoso; vacuum e indici restano piccoli |
| Dal primo giorno | ogni query porta `chat_id`, nessuna join tra chat | è la condizione per tutto il resto |
| Oltre ~1 TB di messaggi | `messages`, `chats`, `chat_members` su un Postgres dedicato | l'inbox e i messaggi non fanno join con il resto, se non per i riassunti delle persone, che vengono dalla cache |
| Oltre ~2 TB su una macchina | più Postgres per `hash(chat_id)`, con una tabella `user_chats(user_id, chat_id, last_at)` per l'inbox | la transazione tocca una chat sola, quindi resta su un'unica macchina |
| Messaggi vecchi mai riletti | archivio freddo su R2 per i messaggi oltre 12-24 mesi, per blocchi di `seq`, con `chats.archived_below_seq` | l'API non cambia: `before` sotto quel numero legge il blocco |
| Oltre decine di migliaia di scritture/s | valutare ScyllaDB solo per `messages` | §15: non prima |

**Da non fare ora**: code durevoli per i messaggi, ricerca nel testo, cifratura end-to-end, allegati. Quando arriveranno gli allegati, seguono il §19: una
nuova `purpose`, nessun file che passa dall'API.

### Cosa misurare in produzione

Ritardo tra commit e frame (p95 < 300 ms), messaggi al secondo sulla chat più attiva, dimensione delle partizioni e tempo di vacuum, `sent_messages` duplicati
respinti (se salgono, l'app sta ritentando troppo), socket chiusi con 1013.

## 19. Upload e immagini

**Regola di fondo: nessun file dell'utente viene mai servito così com'è, e il file non passa mai dall'API.** Si tiene solo ciò che il server ha rifatto.

### Il percorso

```
 1. POST /uploads { purpose, mimeType, fileSize, eventId?, chatId? }
      permessi per quella purpose, limiti (sotto), riga in `uploads`, URL firmato verso il bucket PRIVATO
 2. PUT <uploadUrl>   dal telefono direttamente allo storage   → deve rispondere 200
 3. PUT /me/picture, PUT /chats/{id}/picture, POST /events/{id}/photos, PATCH /events/{id} { images }
      `imaged` scarica l'originale, lo controlla, lo rifà, scrive nel bucket PUBBLICO, CANCELLA l'originale
      e tutto il resto nella stessa richiesta: la risposta porta già gli URL finali (o 422 moderated)
```

`POST /uploads` controlla i permessi **e i limiti**: si rifiuta prima che il telefono mandi un byte. Il passo 3 ricontrolla tutto, perché nel frattempo può essere
cambiato. Un upload vale una sola volta, per quella `purpose`, quell'evento o quella chat, e per chi l'ha chiesto.

### Cosa fa l'app con un upload (da rispettare alla lettera)

Dal codice dell'app (`api/uploads.js`, `album/state/AlbumsProvider.js`, `apiConfig.js`):

| L'app | Quindi il server |
|---|---|
| Manda in `fileSize` la dimensione vera del file sul telefono, non quella detta dal selettore | può firmare `Content-Length` esatto (sotto) |
| Fa il `PUT` con `Content-Type: <mimeType>` **più tutto ciò che trova in `headers` del ticket** | ciò che la firma richiede va messo in `headers`: l'app non aggiunge altro di suo |
| Accetta `uploadUrl` solo se è HTTPS e senza credenziali nell'indirizzo (in sviluppo: HTTP sulla stessa origine dell'API) | un URL firmato di R2 va bene; un indirizzo HTTP di un'altra macchina no: l'upload fallisce senza una richiesta |
| Considera riuscito il `PUT` solo con uno stato 2xx | |
| Manda le foto di un album due alla volta, ognuna con `Idempotency-Key: <chiave della foto>` (≤ 64 caratteri), la stessa a ogni tentativo | stessa chiave, stessa persona, stesso evento: **la stessa `Photo`, 201**, com'è adesso (non una copia della prima risposta). Se nel frattempo è stata rimossa non torna: vale la riga sotto |
| **Riprova con lo stesso `uploadId`** per 50 minuti, senza rimandare il file (la risposta alla prima richiesta può essersi persa) | upload già usato: **410 `expired`**. L'app lo legge come "era stata aggiunta": toglie la foto dalla coda e rilegge l'album |
| Dopo un rifiuto vero (4xx diverso da 429) dimentica quell'upload: un nuovo tentativo chiede un ticket nuovo e rimanda il file | |
| Dopo 5xx, 429 o nessuna risposta tiene l'upload e riprova con quello | **un errore del server non deve consumare l'upload**: si segna usato, e l'originale si cancella, nella stessa transazione che crea la foto, oppure quando il file viene rifiutato (422, 413). Se `imaged` non risponde o è pieno (503), l'upload resta com'era e il suo originale pure, fino alla sua ora. Altrimenti il tentativo dopo riceve 410 e l'app crede aggiunta una foto che non c'è |
| Ferma tutta la coda di quell'album a `album_full` e `photo_limit`, con un solo avviso | questi due codici, non un 409 generico |

Il Python segna l'upload usato appena lo prende (`media.take`) e cancella l'originale appena lo apre: lì non esistono errori a metà. In Java, con `imaged` su un'altra macchina, esistono: è l'ultima riga della tabella.

### Il passo 3, in ordine

Due regole di questa scheda qui si toccano: "mai la rete con una connessione del database in mano" (§16) e "un upload vale una volta sola, e un errore del server non lo consuma". Si tengono insieme così:

```
 a. transazione breve: i permessi e i limiti di adesso (§7.3), la chiave di idempotenza dentro il lock sulla persona, poi
      UPDATE uploads SET claimed_at = now(), output_keys = $nomi_nuovi
       WHERE id = $1 AND user_id = $io AND purpose = … AND NOT used AND expires_at > now()
         AND (claimed_at IS NULL OR claimed_at < now() - interval '60 seconds')
      RETURNING storage_key;
      nessuna riga: 410 expired se usato o scaduto, 409 se un'altra richiesta lo sta lavorando, 400 e 403 come nel Python
 b. FUORI dalla transazione: imaged (HEAD, controlli, rifà, scrive i file pubblici con i nomi di `output_keys`)
      rifiuto del file (422, 413):  UPDATE uploads SET used = true; l'originale è già cancellato; rispondi il rifiuto
      imaged non risponde o è pieno: UPDATE uploads SET claimed_at = NULL; l'originale resta; rispondi 503 con Retry-After
 c. transazione: di nuovo i limiti (un'altra foto può essere entrata nel frattempo), INSERT della foto,
      UPDATE uploads SET used = true, riga in idempotency_keys, contatori; dopo il commit: frame e notifiche
      limite superato proprio ora (409 album_full, photo_limit): used = true e un lavoro che toglie i file pubblici appena scritti
```

I nomi dei file pubblici si scelgono in (a), prima di chiamare `imaged`, e stanno sulla riga: se il processo muore tra (b) e (c), `cleanup.sweep` trova l'upload scaduto e non usato e toglie **l'originale e
i file di `output_keys`**. Senza, resterebbero nel bucket pubblico foto che nessuna riga conosce e che niente cancellerà mai. I 60 secondi sono più del tempo massimo di `imaged` (20 s a file): un `claimed_at` più vecchio è di una richiesta morta.
Vale uguale per foto profilo, foto di gruppo e copertine; per `PATCH /events/{id} { images }` si reclamano tutti gli upload in (a) e, se uno solo viene rifiutato, l'evento non cambia e i file già scritti si tolgono (`API.md`: una voce sbagliata non cambia niente).

### I limiti (decisi, e configurabili)

| Limite | Valore | Errore | Perché |
|---|---|---|---|
| Dimensione di un file | 20 MB | 413 `too_large` | una foto da telefono ne pesa 3-6 |
| Pixel | 60 milioni | 422 `moderated` | oltre è una bomba di decompressione |
| Formati | JPEG, PNG, WebP, HEIC | 422 `moderated` | si guarda il contenuto, non ciò che dice il client |
| In attesa per persona | 20 | 429 | altrimenti 120 ticket l'ora da 20 MB farebbero decine di GB sullo storage |
| Vita di un ticket non usato | 15 minuti | | |
| Vita di un file arrivato e non usato | 1 ora | | prima era un giorno, senza motivo |
| Ticket | 120 l'ora per persona | 429 | |
| Foto in un album | 500 | 409 `album_full` | |
| Foto di una persona in un album | 30 (l'organizzatore 200) | 409 `photo_limit` | |
| Foto di una persona al giorno | 100, in tutti gli album | 409 `photo_limit` | |
| Foto tenute di una persona | 2000, in tutti gli album | 409 `photo_limit` | circa 1,3 GB a testa |
| Immagini di un evento | 6 | 400 | |
| Foto profilo e di gruppo cambiate | 30 l'ora per persona | 429 | |

Una foto cancellata libera il posto. Le foto restano quanto il loro evento: fino a 12 mesi dopo la fine. L'app legge `room` da `GET …/photos` e non lascia nemmeno
scegliere più foto di quelle che possono entrare.

### Cosa fa `imaged`

Per ogni immagine lancia un processo `vips thumbnail` e aspetta (non `vipsthumbnail`, che non ha `--fail-on`). Provato con la CLI di libvips 8.16.1 su Debian 13, con file costruiti apposta:

```sh
VIPS_BLOCK_UNTRUSTED=1 VIPS_CONCURRENCY=1 TMPDIR=<cartella del lavoro> timeout 20 \
  vips thumbnail in 'out.jpg[Q=85,optimize_coding,keep=none]' 2048 --height 2048 --size down --export-profile srgb --fail-on truncated
# profilo e gruppo: 512 --height 512 --crop centre      anteprima: 400 --height 400 --crop centre
```

Si lancia con `ProcessBuilder` e una lista di argomenti, mai con una shell. I nomi dei file li sceglie `imaged`, mai l'utente: vips legge opzioni tra parentesi quadre anche nel nome del file.

In ordine:

1. **I byte iniziali decidono il formato**, prima di aprire il file con qualsiasi cosa: JPEG, PNG, WebP o HEIC (`ftypheic`, `heix`, `hevc`, `mif1`), il resto è 422. Questo controllo è **necessario**: con il blocco attivo SVG e PDF non si aprono più
   (provato: senza blocco si aprono, e con il blocco anche un SVG rinominato `.jpg` viene rifiutato), ma **GIF e TIFF restano aperti**.
2. **`vipsheader -f vips-loader` e `-f width`, `-f height`**: il caricatore dev'essere `jpegload`, `pngload`, `webpload` o `heifload`, e i pixel si controllano senza decomprimere (provato: un PNG che dichiara 30.000 × 30.000 si legge in un attimo). Oltre 60 milioni: 422.
3. **Si rifà sempre il file**, con il comando sopra. Tempo massimo per file con `timeout`. La rotazione è applicata e ogni metadato sparisce con `keep=none`. **Provato sui byte del file finale**, per JPEG, PNG, WebP e HEIC con EXIF, GPS, XMP, commenti e testo PNG:
   niente di tutto ciò resta. La stessa prova va tenuta tra i test: il primo controllo sul Python aveva trovato i **commenti JPEG ancora dentro** (`test_nothing_the_file_says_about_itself_stays`).
   `--export-profile srgb` serve perché senza profilo una foto Display P3 di iPhone si vedrebbe spenta. **Con `keep=none` il profilo sparisce: va visto a occhio con una foto vera.**
4. **Il risultato si rilegge** con `vipsheader` prima di salvarlo: larghezza e altezza finiscono nella risposta.
5. **L'originale si cancella subito**, anche se è stato rifiutato: non resta nulla con il GPS dentro. Il selettore di iOS dice "Location Included": il file che arriva può davvero contenerla. La cartella del lavoro si cancella in `finally`: libvips può scriverci i pixel.

Da sapere: un WebP animato diventa il suo primo fotogramma (va bene). Un file tagliato a metà viene rifiutato grazie a `--fail-on truncated`, in tutti e quattro i formati (provato; senza, un JPEG tagliato passerebbe con la parte mancante grigia). Una foto più piccola del limite non viene ingrandita (`--size down`, provato). Una foto HEIC in verticale presa da un iPhone vero va provata, perché il mio file di prova non portava la rotazione dentro il contenitore.

- **Processo separato per ogni immagine** (§5): un crash o un exploit nel codice C su un'immagine costruita ad arte non tocca socket e API. `imaged` gira con un utente senza privilegi e la rete aperta solo verso R2; il processo `vips` in più senza rete e con la memoria limitata (`bwrap --unshare-net`, `prlimit --as`: da provare sulla macchina vera). Con tante richieste insieme: un `Semaphore` con il massimo di lavori paralleli, e se la coda è piena 503 con `Retry-After`.
- **Nel Python** è `Image.open(formats=…)`: senza, Pillow ne apre 44, e EPS esegue Ghostscript.
- **Controllo automatico dei contenuti**: non c'è ancora (D8). `imaged` è il punto dove inserirlo, e la risposta 422 esiste già.

### Lo storage (R2)

- **Con l'SDK Java**: `S3Client` e `S3Presigner` con `endpointOverride`, `Region.of("auto")`, `pathStyleAccessEnabled(true)` e `chunkedEncodingEnabled(false)`, come dice la documentazione di Cloudflare. Mai una chiamata a R2 con una connessione del database in mano.
- **Due bucket**: originali privati, con regola di ciclo di vita che cancella tutto dopo 1 giorno (rete di sicurezza contro ciò che il lavoro non ha tolto); copie pubbliche, su un **dominio diverso dall'API**, sempre con `Content-Type: image/jpeg`, `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=31536000, immutable` e nomi casuali da almeno 128 bit.
- **Il limite di dimensione va imposto**: R2 non supporta i POST firmati con `content-length-range` (documentazione Cloudflare). Firma nel `PUT` il `Content-Type` e il `Content-Length` esatti (l'app dichiara la dimensione vera del file) e **prova** che R2 rifiuti un corpo più grande: non ho trovato una conferma ufficiale. Se non lo fa, `uploadUrl` può puntare a un piccolo Cloudflare Worker che controlla la lunghezza e scrive nel bucket: per l'app non cambia niente, segue l'URL che riceve.
- **Al passo 3** `imaged` fa comunque un `HEAD`: oltre il 110% di quanto dichiarato si rifiuta, e l'originale si cancella.
- Un `PUT` ripetuto dopo l'uso ricrea un file orfano: lo toglie la regola del bucket privato.
- **Cancellare un file vuol dire anche toglierlo dalla CDN**: con `immutable` e un anno di cache, una foto rimossa o di un account cancellato resterebbe raggiungibile da chi ha l'indirizzo. Ogni cancellazione accoda una purge per URL su Cloudflare. I nomi casuali da soli non bastano per l'articolo 17 del GDPR.

## 20. Abusi e correttezza verso gli utenti

Il presupposto è che **il telefono mente**: l'app può essere modificata, e le API si possono chiamare a mano. Ogni riga dice cosa ferma l'attacco e, quando c'è, cosa resta scoperto.

### Posizione e mappa

| Attacco | Cosa lo ferma | Cosa resta scoperto |
|---|---|---|
| **GPS finto per guardare altre zone** | `position_guard`: nessun salto più veloce di un aereo; chi guarda deve farsi vedere (Invisible non vede nessuno); chi è Approximate vede solo zone | a 340 m/s un GPS finto si muove lo stesso, quindi si può girare una città. **Non si può impedire solo dal server.** App Attest e Play Integrity sul socket (senza passaggi per l'utente) sono il passo da fare prima del lancio aperto |
| **Guardare senza farsi vedere** | "vince il modo meno preciso"; `audience` dice il numero vero di chi ti ha sulla mappa | in una folla sei visto da chi ha te tra i suoi 25, e tu forse non vedi loro: lo dice solo il numero |
| **Triangolare chi è Approximate** | punto d'area fisso per quadrato e giorno, distanza calcolata dal punto mostrato, chiave HMAC stabile | si ricava il quadrato da 300 m: è ciò che la modalità promette |
| **Riempire la mappa di qualcuno con account finti** | connessioni sempre per prime, anche sui saluti; limiti di account e di azioni | gli sconosciuti reali di quella persona possono essere coperti; gli amici no |
| **Saluti e inviti a tappeto** | 60 gesti al minuto e 30 inviti l'ora per persona, oltre ai limiti per coppia | |
| **Numeri costruiti ad arte nel frame `presence`** | `heading`, `speed` e `accuracy` validati prima di entrare nel record (§4.10); una coda per socket: un frame non scrivibile non ferma il socket | |
| **Annunci a una piazza** | 1 ogni 10 s, 120 caratteri, arrivano solo a `watchers` | |

### Persone e contatti

| Attacco | Cosa lo ferma | Cosa resta scoperto |
|---|---|---|
| **Raccogliere profili e grafo sociale** | nessuna ricerca; ID casuali; `sees_story`; limite su `/users/*` (600 al minuto per persona) più limite per IP su Cloudflare | chi ha scelto `everyone` espone le connessioni: è la sua scelta |
| **Farsi passare per qualcun altro** | handle solo ASCII, nomi riservati (`support`, `admin`…), niente caratteri nascosti o invertiti (`plain_text`), segnalazione `impersonation` | i nomi visualizzati possono usare lettere simili (cirillico): serve moderazione |
| **Connettersi a distanza** | token 10 s monouso, 100 m se le posizioni ci sono | due persone d'accordo possono farlo mandando il codice e senza posizione: danneggia solo le regole, non qualcun altro. Device integrity è previsto (`CONNECT-PROTOCOL.md`) |
| **Bloccato che continua a vedere** | blocco nei due versi su ogni percorso; effetti a catena al §8; `relationChanged` ripetuto finché la presenza non conferma | |
| **Aggiunto a forza a un gruppo** | solo connessioni di chi aggiunge; puoi uscire; il blocco ti toglie dai gruppi di chi blocchi | |
| **Leggere il passato di un gruppo** | `joined_seq`: si legge solo da quando si è entrati; anche sondaggi e segnalazioni | |
| **Farsi invisibili a chi modera bloccandolo** | chi blocca il proprietario esce dal gruppo; un admin non può aggiungere chi ha un blocco col proprietario; negli eventi il blocco toglie già dall'evento | bloccare un admin che non è il proprietario resta possibile: il proprietario continua a vedere |
| **Sapere chi va a un evento senza poterlo sapere** | nessun nome nei messaggi di uscita; `contributors` solo all'organizzatore; `sees_story` su partecipanti, recensioni, membri, storia; `Poll` senza elenco di votanti | |
| **Scoprire un'email dall'`@handle`** | l'handle nasce dal nome scelto o è casuale, mai dall'indirizzo | |
| **Telefono che passa a un'altra persona** | all'uscita spariscono cache, profilo, meteo e **la scelta di essere visibile**: chi entra dopo parte Invisible e gli viene chiesto il consenso | quello che resta sul telefono si può leggere solo con il telefono sbloccato e con l'app, ma le cache non sono cifrate |
| **Link esterno che apre una schermata** | l'app non dà link propri, quindi ogni link apre la prima pagina (`+native-intent.js`): la schermata Connect mostra il codice | |
| **Backup del telefono** | `allowBackup: false` su Android; le cache di chat e immagini stanno nella cartella cache, esclusa dai backup anche su iOS | |
| **Sconosciuti che scrivono** | solo entro 1 km e mai dopo una disconnessione; 30 chat nuove l'ora; una chat diretta vuota si vede solo da chi l'ha aperta (`opened_by`), così non si riempiono gli elenchi degli altri | |

### Eventi e denaro

| Attacco | Cosa lo ferma | Cosa resta scoperto |
|---|---|---|
| **Occupare un luogo con eventi finti** (15 m) | 5 eventi attivi a testa, 20 creazioni l'ora, inizio entro 31 giorni, segnalazione | con più account si può tenere occupato un posto per settimane: il pannello di moderazione deve poter annullare un evento |
| **Pubblicità gratis per sempre sulla mappa** | una volta iniziato l'inizio non si sposta, e un evento finisce al massimo 62 giorni dopo la creazione | ricrearlo dopo è sempre possibile, ma costa i limiti qui sopra |
| **Recensioni false** | solo chi si è unito, solo da quando inizia | unirsi non prova di esserci stati. **Se un giorno il prestigio darà punti, non basarlo su questo**: servirà un segno "è stato vicino", senza coordinate |
| **Cambiare un evento dopo che la gente si è unita** | tempo e luogo sono notificati | titolo e descrizione cambiano in silenzio: decisione di prodotto |
| **Promozione gratis spostando l'evento** | ciò che è pagato è un tempo e si paga ogni 24 ore, dovunque stia l'evento | nessuno |
| **Comprare solo le ore di punta** | fermare la promozione non restituisce nulla (resta visibile fino a dove è pagata), annullare l'evento restituisce ma le prime 6 ore restano pagate e l'evento è perso | nessuno |
| **Rimborso due volte, o più del pagato** | restituito una volta alla fine, mai oltre `charged - refunded`, arrotondato per difetto | nessuno |
| **Rimborso dei crediti e poi rimborso dell'acquisto** | il saldo può andare sotto zero: niente si paga finché non torna positivo | nessuno |
| **Sconto da evento lungo, poi accorciato** | accorciando si riperde lo sconto dalle 24 ore dopo (`promotions.dates_changed`) | |
| **Ricevute false o riusate** | firma Apple, API Google, una volta per transazione, solo all'account che ha comprato. Sotto la radice di Apple ci sono anche certificati di altri: conta che la foglia abbia l'estensione `1.2.840.113635.100.6.11.1` e l'intermedio `1.2.840.113635.100.6.2.1`. `SignedDataVerifier` della libreria ufficiale lo fa da solo: non scrivere la verifica a mano. Google: `purchaseType` 0 è un account di prova, non paga | il Python controllava solo la radice: chiunque con un certificato di sviluppatore poteva firmarsi crediti gratis. Corretto il 2026-11-05 |
| **Rimborso dopo aver speso** | il saldo può andare sotto zero | |

### Server

| Attacco | Cosa lo ferma |
|---|---|
| **Token rubato** | HTTPS, 1 ora di vita, mai negli URL né nei log; `erased_accounts`; socket chiusi alla scadenza |
| **Account sospeso** (pannello) | controllo a ogni richiesta e chiusura dei socket: va trattato come un account cancellato. L'app oggi non ha una schermata per dirlo: va aggiunta con il pannello |
| **Socket aperti a vuoto** | autenticazione entro 5 s, 5 socket a persona, limite di connessioni per IP al bilanciatore |
| **Flood di frame** | 10 al secondo, picchi di 30, poi chiusura |
| **Flood di richieste** | limite complessivo di 3000 richieste al minuto per persona (nessun uso normale ci si avvicina), più limite per IP su Cloudflare. Si controlla dopo l'autenticazione; prima, ci pensa la CDN |
| **Chi gestisce una chat la inonda** | ruoli, mute, pin e read-only: 120 l'ora per persona; ognuno raggiunge tutti i membri |
| **Corpi enormi** | 256 KB sul REST (un filtro, §16), 64 KB sul socket (chiusura 1009); limiti di Jackson su profondità e lunghezza |
| **Un telefono lento che frena tutti** | coda limitata per socket, 1013 |
| **Link di un evento come SSRF** | il server non apre mai `links`, nomi di file o URL degli utenti: li mostra soltanto |
| **SQL injection** | jOOQ, solo parametri; il SQL scritto a mano solo con modelli e `{0}`, mai concatenando. Un test lo controlla (§21) |
| **Posizioni nei log, nei dump, su disco** | URL mai registrati con la query (§3, §9), `toString()` senza coordinate, niente dump né swap (§21) |
| **Pannelli interni esposti** | Actuator su una porta separata, solo sulla rete privata, solo `health` e `prometheus`: `heapdump` e `env` regalerebbero tutto |
| **Esecuzione di codice da dati** | niente `ObjectInputStream` né default typing, Actuator chiuso, dipendenze controllate (§21) |
| **Dipendenza compromessa** | versioni bloccate e verificate per hash (§21) |
| **Stesso punto per rallentare la mappa** | indice scelto per reggerlo (§15), e la prova di carico lo verifica (§12) |
| **CSRF, CORS** | token Bearer, nessun cookie, nessun CORS sull'API |
| **Risposte personali finite in cache** | `Cache-Control: private`; Cloudflare non deve mettere in cache l'API; la cache in RAM tiene solo la parte pubblica |
| **Sondare cosa esiste** | ID casuali da almeno 72 bit; 404 uguale per "non esiste", "non puoi vederlo" e "id malformato" |
| **Copia dei dati rubata** | link monouso, 10 minuti, `no-store`, `no-referrer` |

## 21. JVM, qualità del codice, rilascio

### La JVM

```
-XX:+UseZGC -XX:+UseCompactObjectHeaders
-Xms<N> -Xmx<N> -XX:+AlwaysPreTouch
-XX:+ExitOnOutOfMemoryError -XX:-HeapDumpOnOutOfMemoryError -XX:-CreateCoredumpOnCrash
-XX:ErrorFile=/run/app/hs_err_%p.log
-XX:+DisableAttachMechanism                       (dove gira la presenza)
-Duser.timezone=UTC -Duser.language=en
```

| Opzione | Perché |
|---|---|
| ZGC | pause sotto il millisecondo: una pausa lunga fermerebbe socket e presenza insieme. Un solo collector per tutti i ruoli, niente da regolare, in cambio di un po' più di CPU e di una heap circa doppia del necessario. Le due opzioni insieme hanno girato senza problemi con JDK 25 |
| `-Xms` = `-Xmx`, `AlwaysPreTouch` | tutta la memoria presa subito: se non c'è il processo non parte, invece di cadere dopo giorni. All'inizio, una macchina da 64 GB con tutti i ruoli: 16 GB. Il valore giusto lo dice il §12 |
| `ExitOnOutOfMemoryError` | meglio ripartire che restare vivi e rotti |
| Niente dump | **un dump della memoria contiene posizioni, messaggi e token: violerebbe "la posizione non tocca mai il disco"**. `DisableAttachMechanism` impedisce anche `jcmd`. L'`ErrorFile` di un crash sta su una cartella in RAM |
| Fuso e lingua | il server non dipende dalla macchina |

**Systemd e macchina**: `User=app`, `NoNewPrivileges=true`, `ProtectSystem=strict`, `PrivateTmp=true`, `LimitCORE=0`, `LimitNOFILE=1048576`, `Restart=always`, `TimeoutStopSec=90`, `EnvironmentFile` con permessi 600 per i segreti. **Swap spenta** e dischi cifrati. Orologi con `chrony`.

### Chi gira dove

| Cosa | Thread | Regola |
|---|---|---|
| Richieste REST | un virtual thread a richiesta (`spring.threads.virtual.enabled=true`) | possono bloccare. Niente `ThreadLocal` come cache: i virtual thread non si riusano |
| Presenza | **un thread normale** | non blocca mai (§5) |
| Callback dei socket | Jetty | non bloccano mai. Provato: con i virtual thread attivi girano anche loro su virtual thread, ma la regola resta, perché l'ordine dei frame dipende da questo |
| Invio ai socket | pochi thread normali | uno per gruppo di socket |
| Lavori | db-scheduler | ripetibili |
| Verifica di `auth`, relazioni, riassunti | virtual thread | il risultato torna con un messaggio |

**Il database**: HikariCP con un pool piccolo, circa il doppio dei core di Postgres diviso tra i nodi; `connectionTimeout` 2 s; con `connectionInitSql` `statement_timeout=5s`, `lock_timeout=2s`, `idle_in_transaction_session_timeout=10s`. Le rotte lente (`DELETE /me`) stanno nei lavori. Ogni client HTTP in uscita ha timeout di connessione e di risposta, e non segue i redirect.

### I controlli, dal primo giorno

Attivi nella build. Un errore ferma la build: aggiunti dopo, costringono a correggere migliaia di righe.

| Controllo | Cosa ferma |
|---|---|
| `javac -Xlint:all,-serial -Werror` | conversioni e usi sospetti |
| Error Prone (`net.ltgt.errorprone`) + NullAway + JSpecify (`@NullMarked`) | errori tipici, e **i `NullPointerException` già alla compilazione**; è anche ciò che garantisce le liste mai `null` (§16) |
| SpotBugs + FindSecBugs | bug e pattern insicuri |
| ArchUnit | i confini del §5 (`presence` e `gateway` senza Spring, `presence` senza database); vietati `@Transactional`, `ObjectInputStream`, `System.out`, `new Random`, `Thread.sleep` in `presence` |
| Gradle: `dependencyLocking` + `gradle/verification-metadata.xml` | versioni bloccate, hash di ogni jar verificati: una dipendenza manomessa non compila |
| OWASP dependency-check, Dependabot, SBOM con CycloneDX | vulnerabilità note |

**I test che non possono mancare**:

| Test | Perché |
|---|---|
| Testcontainers con **Postgres e PostGIS veri**, mai H2 | la metà delle regole sta nel database |
| Una gara vera per ogni riga del §7.3 (due o più transazioni insieme) | la prova dei 15 m dimostra che il ragionamento da solo non basta |
| `NearIndex` contro il calcolo su tutti (`jqwik`): mosse e cancellazioni casuali, stessi punti, poli, antimeridiano | è il cuore: un indice sbagliato non si vede dai tempi |
| Tutte le rotte (da `RequestMappingHandlerMapping`) senza token: 401, tranne la lista del §8 | una rotta aperta per sbaglio si vede subito |
| Tutti gli SQL scritti a mano: nessuna concatenazione (ArchUnit + `@PlainSQL` di jOOQ) | SQL injection |
| Denaro con `jqwik`: rimborsi mai oltre il pagato, saldo = somma del ledger | |
| `imaged`: sui byte del file finale, con i file costruiti del §19 | privacy |
| Socket su un server vero: 4001, 1008, 1009, 1013, binario, deflate spento | una volta a mano ho provato tutto tranne 1008, che è una regola da scrivere: va tenuto come test |
| `toString()` e log senza coordinate né token | |
| **I test Python contro il server Java** (§13) | è la specifica eseguibile: la prova più forte di compatibilità con l'app |

### Rilascio e aggiornamenti

- **Migrazioni compatibili all'indietro**, perché durante un rilascio a rotazione girano la versione vecchia e la nuova: prima si aggiunge, si rilascia, e solo al rilascio dopo si toglie. Flyway gira come passo a sé, prima dei nodi.
- **All'avvio con `PRODUCTION=1`** il server controlla la configurazione e non parte se manca qualcosa (`config.production_problems`, più `AREA_HMAC_KEY`, `DATABASE_URL`, catalogo; `TRUST_UNVERIFIED_TOKENS` e `DEV_TOOLS` spenti).
- **Spegnimento ordinato**: `server.shutdown=graceful`, i socket chiusi a poco a poco (§5), la presenza libera il suo lock.
- **Gli aggiornamenti sono parte del lavoro**, e vanno in calendario: il JDK ogni trimestre (patch di sicurezza di gennaio, aprile, luglio e ottobre); Spring Boot ogni mese per le patch, ogni anno per la minor (la 4.1 esce di supporto gratuito circa a luglio 2027, da una fonte non ufficiale: controlla la pagina di Spring); il prossimo JDK LTS è il 29, a settembre 2027, senza fretta.

### Cosa guardare in produzione

Micrometer e Prometheus, sulla porta interna: durata del giro della presenza e delle coda `frames`, frame persi, socket aperti, chiusure 1008 e 1013, attesa del pool e connessioni in uso, pause del GC, durata e fallimenti dei lavori, 5xx per rotta (con il modello della rotta, mai l'URL vero). Per capire un rallentamento: JFR e async-profiler, mai un dump. Gli allarmi minimi: giro oltre 0,5 s, 5xx oltre l'1%, attesa del pool, disco di Postgres, backup falliti.

## 22. Cosa è stato provato davvero

### Provato il 2026-11-05: `EventTheme` del §16

Le regole della classe, compilate con `javac` e confrontate con `_theme` del Python su 31 casi (forme sbagliate, valori
sconosciuti, tipi sbagliati, a capo in fondo, 16 e 17 emoji, scritte al posto del simbolo, campi ignoti): **risultati identici** e nessun crash.
**Non provata con il vero Jackson**: in quella prova `JsonNode` era un piccolo sostituto con gli stessi metodi, perché Maven non si
poteva lanciare da lì. `Body.string` è quello già provato sopra; il sostituto non controlla i NUL e i caratteri spezzati, e
`Text.plain` era senza filtro. I test `test_the_beam_of_an_event_is_its_own_colour`,
`test_a_theme_is_replaced_whole_and_its_colours_kept_as_sent`, `test_changing_the_look_alone_tells_nobody` e `test_the_look_of_what_took_place_stays_as_it_was` (`tests/test_scenarios.py`) passano sul Python: sono la prova da rifare contro Java, insieme ai valori rifiutati di `tests/test_security.py`.

### Provato il 2026-11-04, in Docker, con le versioni di questa scheda

| Cosa | Risultato |
|---|---|
| Lo schema del §7.1 su PostgreSQL 18.6 + PostGIS 3.7 | si crea; le query del §4.8 usano l'indice GiST e trovano la promossa |
| **15 m tra eventi con `SERIALIZABLE`** | **rotto**: due eventi nello stesso punto 13 volte su 24 (12 su 12 in una zona vuota). Con il lock esplicito, 0 su 24 |
| `uuidv7()` di Postgres | i 12 bit dopo la versione crescono: 62 bit casuali, sotto i 72 di `API.md`. `Ids.next()` ne ha 74 |
| Posti di un flash: 20 `UPDATE` insieme su 5 posti | entrati 5 |
| 800 messaggi da 8 mittenti insieme | `seq` senza buchi, `at` sempre crescente; 786 aggiornamenti di `chats` su 800 sono HOT; una query tocca una partizione |
| `SKIP LOCKED`, vincolo sul rimborso | una riga non si prende due volte; oltre il pagato il database rifiuta |
| PH-Tree in 3 dimensioni contro `distance_m` | 4.131 confronti con poli, antimeridiano, persone nello stesso punto: nessuna differenza |
| Otto indici contro il calcolo esatto, 18.129 confronti ciascuno | sette esatti; il KD-tree cade prima di finire (stack da 512 KB) |
| Jackson 3 predefinito e configurato | il predefinito accetta i casi del §16; `Json` e `Body` li rifiutano |
| Nimbus | accetta e rifiuta i token come detto al §16; `at+jwt` va abilitato |
| Matching completo a tempo reale, fino al limite (§4.4) | il thread si satura tra 80.000 e 200.000 persone secondo la densità; a ogni livello nessun frame perso, coppie coerenti, risultati esatti. Su un Mac, senza rete |
| Testi, handle, date, distanze contro il Python | nessuna differenza, su tutti i caratteri Unicode |
| Spring Boot 4.1.2 + Jetty 12.1 sulla stessa porta, virtual thread | REST e socket insieme; `event%3A…` decodificato; errori sempre in JSON; gzip, ETag e 304; 411 e 413; socket: testo, binario, 4001, 1009, deflate spento, telefono che non legge |
| db-scheduler con lo starter per Boot 4 | transazione annullata: niente lavoro; confermata: parte, con i dati in JSON |
| CLI di libvips 8.16.1 | §19: formati, metadati, rotazione, file tagliati, bomba di pixel |

Sono prove usa e getta, fatte per trovare errori del progetto, e non sono nel repository; il server vero ha i suoi test in `backend-java/`.

### Cinque errori che questa versione corregge

Valevano anche nel progetto in Go, e nessuno si sarebbe visto nelle prove normali:

1. La regola dei 15 m non reggeva due richieste insieme (§7.3).
2. La ricerca dei vicini con il margine di 300 m tornava quadratica nelle folle (§4.5).
3. Latitudine e longitudine trattate come numeri piani sbagliavano distanze e scelte (§4.5).
4. `uuidv7()` di Postgres non dà i bit casuali che il contratto chiede (§7.2).
5. Le coordinate nell'URL di `GET /events` finivano nei log di accesso (§3, §9).

### Non provato

- **Il carico con la rete**: socket per macchina, latenze vere da telefono a telefono, CPU del gateway, banda. Solo stime: §12, sulla macchina vera. Il matching da solo è misurato (§4.4), ma su un Mac.
- **Telefoni veri** con il server Java, e il tetto di 25 (§4.2).
- **Logto vero**: il `typ` dei suoi token; serve solo aprire un token vero.
- **R2 vero**: che rifiuti un corpo più grande del firmato (§19). L'SDK è configurato come dice Cloudflare, ma non l'ho eseguito contro R2.
- **L'isolamento del processo `vips`** (§19).
- **Cloudflare e HAProxy** (§9): limiti, `Content-Length` che arriva, TLS, Authenticated Origin Pulls.
- **Una foto vera di iPhone** su `imaged`: rotazione di HEIC e colori Display P3 (§19).
- **Apple e Google**: acquisti e push con le librerie indicate. Ne ho controllato l'esistenza e la versione, non il funzionamento.
- **jOOQ con PostGIS, Flyway, NATS, Lettuce, Error Prone, NullAway**: scelti per ciò che documentano, non eseguiti qui.
