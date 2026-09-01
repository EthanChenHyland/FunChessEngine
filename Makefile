SHELL := /bin/bash

UV := $(shell command -v uv 2>/dev/null || printf '%s' '/Users/ethius/AI-Workspace/runtimes/uv/bin/uv')

.PHONY: setup play arena benchmark gui desktop desktop-dev desktop-build test zip gate

setup:
	$(UV) sync

play:
	$(UV) run python -m harness.play --white . --black baselines/greedy $(if $(FEN),--fen "$(FEN)")

arena:
	$(UV) run python -m harness.arena --opponent baselines/greedy --games 20

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

gate:
	$(UV) run ruff check .
	$(UV) run mypy
	$(UV) run python -m unittest discover -v
	$(UV) run python -m harness.arena --opponent baselines/random --games 2 --base-ms 5000
