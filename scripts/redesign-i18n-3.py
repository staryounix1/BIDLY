#!/usr/bin/env python3
"""Add the third batch of redesign keys (small gap-fills)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MESSAGES = ROOT / "apps" / "web" / "src" / "messages"

NEW = {
    "ar": {
        "offer": {
            "customerOffer": "السعر المقترح من الزبون",
            "counterWith": "اقترح سعرك",
        },
        "tracking": {
            "status": "حالة الطلب",
        },
    },
    "en": {
        "offer": {
            "customerOffer": "Customer's offer",
            "counterWith": "Counter with your price",
        },
        "tracking": {
            "status": "Request status",
        },
    },
    "fr": {
        "offer": {
            "customerOffer": "Offre du client",
            "counterWith": "Proposez votre prix",
        },
        "tracking": {
            "status": "Statut de la demande",
        },
    },
}


def deep_merge(base: dict, extra: dict) -> dict:
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def main() -> int:
    for locale in ("ar", "en", "fr"):
        path = MESSAGES / f"{locale}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        deep_merge(data, NEW[locale])
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"{locale}: merged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
