# Art direction della mappa

Decide *come deve apparire* la scena della mappa (cielo, orizzonte, nebbia, nuvole,
meteo, colori del terreno) prima di ogni singolo valore. Ogni scelta successiva si
giudica contro questo file. I valori stanno in `src/looks/` (un look = un file di dati).

## 1. Idea centrale

**La tua città, un attimo prima di incontrarsi.**

L'app serve a incontrare persone dal vivo, agli eventi del proprio quartiere. La mappa
non deve sembrare un territorio da esplorare (Pokémon GO) né una cartina da consultare
(Google Maps): è il posto dove *sta per succedere qualcosa con qualcuno*. Attesa, aria,
luce calda sulle cose, gente che esce.

## 2. Attributi visivi

| Sensazione | Direttiva visiva (l'attributo) |
|---|---|
| attesa, calore | **luce calda, ombra fredda**: le superfici prendono il colore della luce, le ombre e la foschia sono fredde. Mai grigio neutro |
| aria, spazio | **profonda**: piani d'atmosfera distinti; la città lontana si scioglie nel colore del cielo, non nel bianco |
| orientarsi senza sforzo | **leggibile per valori**: strade il tono più scuro, terreno il medio, vetro dei palazzi il più chiaro |
| simpatia senza plastica | **opaca**: niente nero puro né bianco puro; i bordi sono inchiostro colorato |
| vita | **luce che cambia**: ombre di nuvole che passano, riflesso del sole, lampioni all'imbrunire |

## 3. Riferimenti (fuori dal settore: niente giochi su mappa)

- **Olly Moss, poster per *Firewatch*** (illustrazione) → piani di distanza piatti, ognuno un tono più vicino al cielo.
- **Hiroshi Nagai, copertine city pop** (illustrazione) → cielo cobalto pieno, bianchi che bruciano, ombre turchesi nette.
- **David Hockney, *A Bigger Splash*** (pittura) → campiture piatte, acqua ciano, luce del sud senza grigio.
- **Kazuo Oga, fondali Ghibli** (animazione) → cumuli illuminati con le pance blu-lilla, mai grigie.
- **Edward Hopper, *Nighthawks*** (pittura) → la notte come sacche di luce calda dentro il blu.
- **Stampa risograph** (grafica) → pochi inchiostri; un colore del cielo che tinge tutto per sovrastampa.
- **Luigi Ghirri, la pianura padana** (fotografia) → foschia lattiginosa, orizzonte che sparisce senza linea.
- **Massimo Vignelli, mappa della metro di New York 1972** (grafica) → gerarchia delle linee per peso e colore, non per dettaglio.
- **Roma al tramonto, intonaci** (architettura) → terracotta e ocra, luce radente rosa sulle facciate.

## 4. Direzione di resa

- **Soggetto**: il quartiere vero, come un plastico; persone ed eventi sono l'unica cosa satura per scelta.
- **Trattamento**: campiture piatte senza illuminazione (leggere su ogni telefono); la luce si
  esprime con tre soli strumenti: colore dell'atmosfera, foschia dal lato del sole, riflessi.
- **Distanza**: inquadratura ampia dall'altezza del giocatore; il lontano conta quanto il vicino.
- **Colore nell'immagine**: lo porta la mappa; il cielo lo conferma, non lo contraddice.
- **Movimento**: si muovono solo nuvole, ombre di nuvole, acqua e persone. Mai la camera da sola.

## 5. Come ci si è arrivati

Tre concetti provati sulla mappa il 2026-10-21: A "Diorama" (salvia e blu notte: troppo
simile a Pokémon GO), B "Città pop" (intonaco corallo, oltremare, cielo cobalto) e C
"Strati" (ora d'oro perenne, prugna e lilla, fasce di distanza). Scelto un misto: la città
di B sotto il cielo e la notte di C. Gli altri, con il selettore dei look, sono stati tolti.

## 6. La scelta: Piazza

La città di B sotto il cielo e la notte di C (`src/looks/piazza.js`, l'unico look; le
distanze della nebbia in `src/config.js`). Il cielo di mezzogiorno resta cobalto, così
non sembra sempre sera.

- **Terreno**: intonaco corallo-albicocca; quartieri un po' più rosa o più albicocca
  (`paint.hue`), pennellate morbide di valore (`paint.wash`).
- **Strade**: blu-violetto piatto, senza grana (stilizzato, non asfalto); opache: niente
  riflessi del cielo e niente ombre di nuvole sopra (sembravano nuvole riflesse). Il bordo
  panna è il lampione: di notte si accende d'oro, l'interno diventa blu profondo.
- **Palazzi**: bassi (1,6 m), vetro chiaro e caldo più pieno del terreno, muri più scuri:
  i tetti si staccano dalle strade e dai cortili corallo. Nessuno shader sui palazzi.
- **Cielo**: cobalto in alto, lilla e lavanda in basso, foschia calda dal lato del sole,
  alta e morbida sopra il bordo della mappa (nessuna linea); colline viola. Le nuvole
  scendono fino al bordo del mondo (`MAP_EDGE_SLOPE`): nessuna fascia di cielo vuoto.
- **Profondità**: nebbia a gradiente da 60 m, piena a 680 m (prima del bordo del mondo,
  che così non si vede); primo piano più profondo, il lontano vira al lilla, banchi di
  nebbia che scorrono lenti dove la nebbia è a metà.
- **Meteo**: le ombre delle nuvole sono pozze lilla; la pioggia raffredda (rosa polvere,
  viola), non scurisce in marrone; il bagnato è freddo, mai fango.
- **Notte**: blu pulito con l'orizzonte viola, mai nera né fangosa; le strade disegnate
  dalla luce dei bordi.

Costo: due letture di texture per pixel per le variazioni del terreno, una per i banchi
di nebbia; le tile si caricano solo fino a dove la nebbia è piena (780 m).

## 7. Cosa non vogliamo

Cliché del settore:
- Tutto verde prato (Pokémon GO).
- Beige e bianco da navigatore (Google Maps).
- Notte neon cyberpunk.
- Pioggia come grigio che spegne tutto: fango, colori morti.
- Cielo come gradiente azzurro senza foschia, con l'orizzonte tagliato netto.
- Notte nera: la mappa deve restare usabile.

Esclusioni:
- Niente grigio neutro: ogni grigio è tinto (verso il cielo o verso la luce).
- Niente bianco puro sul terreno; il bianco è solo del vetro e delle nuvole al sole.
- Niente bloom o glow per far sembrare ricca una scena povera.
- Niente effetti che costano su un telefono debole: solo colore, nebbia e pochi passaggi.
- Niente interno della strada che si accende di notte: si accende il bordo.
- Niente orizzonte netto, niente linea di luce sul bordo, niente fine del mondo visibile.
- Niente riflessi o ombre di nuvole sulle strade; niente realismo (grana d'asfalto): stilizzato.
- Niente tramonto perenne: a mezzogiorno il cielo è blu.
- Niente effetti sui palazzi (muri sole/ombra, finestre): provati e scartati; palazzi più alti scartati.
