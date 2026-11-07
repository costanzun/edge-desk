"""KumoRFM / NVIDIA Kumo Relational as an experimental probability model (placeholder; the
full integration lives below once built). Off by default; runs only with KUMO_API_KEY."""

from __future__ import annotations

import os
from typing import Any


def api_key() -> str | None:
    return os.environ.get("KUMO_API_KEY") or None


def status(enabled: bool) -> dict[str, Any]:
    key = api_key()
    return {"enabled": bool(enabled), "available": key is not None, "active": bool(enabled and key),
            "message": ("Set KUMO_API_KEY in .env to enable" if not key else
                        "Enabled" if enabled else "Key found; switch it on in Settings")}
