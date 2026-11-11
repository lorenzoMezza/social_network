# tile-provider

Crea i tile vettoriali della mappa dell'app, a **zoom 16**, partendo da OpenStreetMap. Il
risultato è un unico file per area (`output/<area>.pmtiles`), da servire con `make serve`
o da caricare su un server o una CDN.

## Requisiti

- Docker (Docker Desktop su macOS), Node ≥ 23.8, make
- Spazio su disco: circa 10 volte l'estratto OpenStreetMap dell'area (vedi sotto per il mondo)

## Comandi

| Comando | Cosa fa |
|---|---|
| `make tiles AREA=roma` | crea `output/roma.pmtiles` |
| `make serve` | serve tutti i file di `output/` come un'unica sorgente: `http://<computer>:8093/tiles.json` |
| `make test` | test dell'alleggerimento |
| `make clean` | cancella download e file temporanei (`data/`); `output/` resta |

Aree con un nome: `roma`, `new-york`, `shanghai`, `norvegia`, `svezia`, `danimarca`,
`polo-nord` (Svalbard, la terra più vicina al polo), `mondo`. Va bene anche qualunque id di
[Geofabrik](https://download.geofabrik.de) (`AREA=italy`, `AREA=us/california`…), e
`BOUNDS=ovest,sud,est,nord` ritaglia un rettangolo. Le aree si aggiungono in `src/areas.mjs`.

Gli estratti scaricati restano in `data/sources/` per un giorno, così un secondo
`make tiles` della stessa area non li riscarica. Rifare un'area sostituisce il suo file in
`output/` solo a lavoro finito.

## Come funziona

1. **Estratto OpenStreetMap** da Geofabrik, aggiornato ogni giorno.
2. **[Planetiler](https://github.com/onthegomap/planetiler)** (schema OpenMapTiles 3.16, in
   Docker) genera un solo zoom e solo i layer che la mappa disegna: `water`, `landcover`,
   `landuse`, `park`, `building`, `transportation`. Non generati: `waterway`, nomi, POI,
   luoghi, confini, numeri civici, aeroporti.
3. **Alleggerimento** (`scripts/slim.mjs`, un thread per core). Restano solo gli oggetti e gli
   attributi che la mappa disegna o legge:
   - **Strade tolte**: tutto ciò che è in galleria (sotto terra non si vede), traghetti, moli,
     strade in costruzione, piste, scale, corridoi, banchine, passi carrabili, corsie dei
     parcheggi.
   - **Restano**: tutte le strade, anche quelle private, le strade di campagna (`track`), i
     sentieri e le ferrovie (treni, metro in superficie, tram), che la mappa disegna in rilievo.
   - **Marciapiedi** (`src/sidewalks.mjs`): OpenMapTiles perde il tag `footway=sidewalk`, quindi
     si riconoscono dalla forma. Una `footway`, `cycleway` o `bridleway` viene tolta se corre
     per il 70% della sua lunghezza entro 12 m da una strada **e parallela** a essa (entro 45°),
     se è un attraversamento (fino a 30 m, taglia una strada) o un mozzicone (fino a 10 m, finisce
     su una strada). Restano i sentieri e le vie pedonali che collegano due strade (l'imbuto di
     Via Cardinal Mistrangelo a Roma). Confrontato con i tag di OpenStreetMap a Villa Borghese,
     Prati e Monte Mario: tolti l'86–91% dei marciapiedi, tenuti il 74–86% degli altri sentieri.
   - **Ponti solo dove servono** (`src/levels.mjs`): una strada su ponte (o più in basso) tiene il
     suo livello solo entro 25 m da dove incrocia una linea disegnata di un altro livello; il resto
     torna strada normale e si unisce a quella che continua. In OpenStreetMap il ponte è spesso
     tutta l'opera, anche sopra cose che la mappa non disegna (una strada in galleria).
   - **Parti di edificio sollevate** (da 3 m in su: pensiline, passerelle, coperture sopra le
     strade): tolte. La mappa estrude ogni sagoma da terra, e diventerebbero blocchi di vetro
     appoggiati sulla strada.
   - **Aree protette** (`park`: riserve, parchi nazionali e regionali): restano con la sola
     classe (`national_park`, `nature_reserve`, il resto `protected_area`). La mappa le
     disegna sotto ogni altra area, così colorano solo la terra che nient'altro descrive:
     intorno a Roma coprono circa 1.000 km², di cui un sesto senza altro sopra e quasi senza
     edifici (1,9%); il resto è sotto boschi, campi, quartieri e mare.
   - **Attributi rimasti**: strade e ferrovie `class`, `subclass`, `ramp`, ponti (`brunnel`) e
     `layer`; edifici `render_height` e `render_min_height`; aree `class` e `subclass`.
   - **Tratti di strada uniti**: quelli che si toccano agli estremi e, senza gli attributi
     inutili (senso unico, fondo, accesso bici…), sono uguali. Restano gli stessi punti
     nello stesso ordine, quindi la mappa disegna le stesse strade. Dove due tratti si
     toccavano, un raccordo prende il posto di due estremità sovrapposte. OpenMapTiles fa lo
     stesso (`FeatureMerge.mergeLineStrings`), ma con molti più attributi diversi.
   - **Strade parallele vicine** (le due carreggiate di un viale): non vengono fuse, perché
     fonderle sposterebbe le strade.
4. **Zoom 16**: Planetiler arriva al massimo allo zoom 15, quindi l'alleggerimento taglia ogni
   tile nei suoi 4 figli (`src/splitTile.mjs`): coordinate raddoppiate, linee e aree ritagliate
   sul figlio più un margine di 64 unità (come quello di OpenMapTiles, così le strade di due
   tile vicine si sovrappongono). Lo zoom è `ZOOM` in `src/rules.mjs`, lo stesso della mappa
   in `webview/map/src/config.js`: si cambiano insieme.
5. **PMTiles** (go-pmtiles): un solo file, con i tile identici (mare aperto, ghiaccio)
   salvati una volta sola.

Le regole (`src/rules.mjs`) decidono cosa arriva alla mappa; la mappa
(`webview/map/src/map/mapSchema.js`) si limita a mandare ogni oggetto al suo stile
(`webview/three-geo-play/src/style/layers/`). Se la mappa inizia a disegnare qualcosa di
nuovo, aggiorna `rules.mjs` e rigenera i tile.

**Perché zoom 16.** La telecamera del gioco guarda un pezzo di mappa davanti al giocatore: la
mappa scarta le tile fuori dall'inquadratura, e più sono piccole, meno geometria inutile
disegna. Misurato a Roma in sei punti, stessa camera e stesso raggio (1,1 km): triangoli
disegnati da 135.000–420.000 (zoom 14) a 48.000–167.000 (zoom 15) a 25.000–107.000 (zoom 16);
le draw call non crescono (una per materiale, per tutte le tile insieme).

**Risultato su Roma** (Roma Capitale, zoom 16, circa 2 minuti): 19,0 MB (zoom 15: 14,3 MB,
zoom 14: 11,3 MB; ogni tile porta il suo margine), sentieri, ferrovie e aree protette compresi.
Pesano soprattutto gli edifici, che non si possono ridurre senza cambiarne la forma.

## Provarli nell'app

Sono l'unica sorgente di tile della mappa: `make dev` dell'app avvia da solo il server
(`scripts/serve.mjs`, porta 8093) e l'app usa `http://<computer>:8093/tiles.json`. Il
server unisce tutte le aree di `output/`: ogni tile arriva dall'area che lo contiene (se
due si sovrappongono, da quella più piccola), fuori da tutte la risposta è vuota. Un'area
creata o rifatta con `make tiles` mentre il server è acceso si vede subito, anche sul
telefono che l'aveva già in cache (i tile vengono ricontrollati con l'ETag; le risposte
vuote non vanno mai in cache). Ogni 5 secondi il log (`.dev/logs/tiles.log` con `make dev`)
riassume, per dispositivo, i tile serviti, quelli vuoti e la zona chiesta: se un telefono
non disegna nulla, lì si vede se raggiunge il server e se la sua zona ha un'area.

- **Da solo**: `make serve` qui, se `make dev` non è acceso.
- **Browser**: con `npm --prefix webview/map run dev` attivo, apri
  `http://localhost:8091/map.html` (`?tiles=<TileJSON>` per un altro server).

## Su un server o una CDN

Un file `.pmtiles` contiene un'intera area; un server lo legge a pezzi (HTTP range):

- **Server**: `scripts/serve.mjs` (quello di `make serve`), `pmtiles serve` o [Martin](https://github.com/maplibre/martin),
  con la CDN davanti.
- **Senza server**: il file su uno storage S3/R2 e, davanti, il worker Cloudflare di
  [Protomaps](https://docs.protomaps.com/deploy/), che risponde a `/{z}/{x}/{y}.mvt`.

La mappa dell'app vuole un TileJSON o un indirizzo `{z}/{x}/{y}`; non legge direttamente
`pmtiles://`.

Dove si usano i tile va mostrato: **© OpenMapTiles © OpenStreetMap contributors** (licenza
ODbL dei dati OpenStreetMap).

## Il mondo intero

`make tiles AREA=mondo` scarica il planet di OpenStreetMap (circa 92 GB). Servono un
computer Linux con almeno 1 TB libero su SSD e almeno 64 GB di RAM. Lo zoom 15 ha quattro
volte i tile dello zoom 14 (e il taglio allo zoom 16 altre quattro): su 16 core Planetiler
impiega diverse ore, l'alleggerimento
altrettanto. Per provare, meglio partire da un paese.
