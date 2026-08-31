SHELL := /bin/bash

.PHONY: setup play arena benchmark gui test zip gate

setup:
	uv sync

play:
	uv run python -m harness.play --white . --black baselines/greedy $(if $(FEN),--fen "$(FEN)")

arena:
	uv run python -m harness.arena --opponent baselines/greedy --games 20

benchmark:
	uv run python -m harness.benchmark

gui:
	uv run python -m gui.server

test:
	uv run python -m unittest discover -v

zip:
	uv run python -m harness.package

gate:
	uv run ruff check .
	uv run mypy
	uv run python -m unittest discover -v
	uv run python -m harness.arena --opponent baselines/random --games 2 --base-ms 5000
