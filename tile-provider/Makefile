# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

# The tiles of the app's map, made here and served from anywhere (one day a CDN):
#   make tiles AREA=roma    output/roma.pmtiles
#   make serve              every output/*.pmtiles as one source, http://<this computer>:8093/tiles.json
#   make test | clean       (README.md)

SHELL := /bin/bash
.DEFAULT_GOAL := help
.PHONY: help tiles serve test clean

PLANETILER := openmaptiles/planetiler-openmaptiles:3.16
PMTILES    := protomaps/go-pmtiles:v1.31.2
PORT       := 8093

help:
	@echo "make tiles AREA=<area>   zoom-16 tiles of an area → output/<area>.pmtiles"
	@echo "             areas: roma, new-york, shanghai, norvegia, svezia, danimarca, polo-nord, mondo"
	@echo "             or any Geofabrik id (italy, us/california…); BOUNDS=west,south,east,north crops it"
	@echo "make serve   serve every output/*.pmtiles as one source on port $(PORT) (/tiles.json)"
	@echo "make test    tests of the slimming"
	@echo "make clean   delete downloads and temporary files (output/ stays)"

node_modules/.installed: package.json package-lock.json
	npm install
	@touch $@

tiles: node_modules/.installed
	@[ -n "$(AREA)" ] || { echo "Which area? make tiles AREA=roma (make help)"; exit 1; }
	@PLANETILER=$(PLANETILER) PMTILES=$(PMTILES) node scripts/tiles.mjs "$(AREA)" $(BOUNDS)

serve: node_modules/.installed
	@ls output/*.pmtiles >/dev/null 2>&1 || { echo "No tiles yet: make tiles AREA=roma"; exit 1; }
	@PORT=$(PORT) node scripts/serve.mjs

test: node_modules/.installed
	node --test test/*.test.mjs

clean:
	rm -rf data node_modules
