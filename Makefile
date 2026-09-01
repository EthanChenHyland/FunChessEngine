SHELL := /bin/bash

UV := $(shell command -v uv 2>/dev/null || printf '%s' '/Users/ethius/AI-Workspace/runtimes/uv/bin/uv')

.PHONY: setup play arena ab benchmark gui desktop desktop-dev desktop-build test zip verify-zip gate release-gate

setup:
	$(UV) sync

play:
	$(UV) run python -m harness.play --white . --black baselines/greedy $(if $(FEN),--fen "$(FEN)")

arena:
	$(UV) run python -m harness.arena --opponent baselines/greedy --games 20

ab:
	@test -n "$(COMPARE)" || (echo "usage: make ab COMPARE=../old-engine [GAMES=12]" && exit 2)
	$(UV) run python -m harness.arena --opponent "$(COMPARE)" --games "$(or $(GAMES),12)" --base-ms "$(or $(BASE_MS),5000)" --increment-ms "$(or $(INC_MS),100)" --fen-file harness/openings.fen

benchmark:
	$(UV) run python -m harness.benchmark $(if $(COMPARE),--compare "$(COMPARE)") $(if $(CLOCK_MS),--clock-ms "$(CLOCK_MS)")

gui:
	$(UV) run python -m gui.server

desktop:
	cd desktop && npm run start

desktop-dev:
	cd desktop && npm run dev

desktop-build:
	cd desktop && npm run build

test:
	$(UV) run python -m unittest discover -v

zip:
	$(UV) run python -m harness.package

verify-zip: zip
	$(UV) run python -c 'import zipfile; z=zipfile.ZipFile("engine-package.zip"); names=z.namelist(); assert names == ["agent.py"] or all(n == "agent.py" or n.startswith("weights/") for n in names), names; print("engine package isolation OK:", ", ".join(names))'

gate:
	$(UV) run ruff check .
	$(UV) run mypy
	$(UV) run python -m unittest discover -v
	$(UV) run python -m harness.arena --opponent baselines/random --games 2 --base-ms 5000

release-gate: gate verify-zip
	node --check gui/static/app.js
	cd desktop && npm run check
	cd desktop && npm audit --omit=dev
