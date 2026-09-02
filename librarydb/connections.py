"""Process-local coordination for snapshots and short database operations."""

from __future__ import annotations

import threading

DATABASE_LOCK = threading.RLock()
