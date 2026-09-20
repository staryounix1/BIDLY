#!/usr/bin/env python3
"""Add the second batch of redesign keys to the web i18n catalogs.

Idempotent: deep-merges, so re-running never duplicates or reorders existing
keys. Run after scripts/redesign-i18n.py.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MESSAGES = ROOT / "apps" / "web" / "src" / "messages"

NEW = {
    "ar": {
        "home": {
            "greeting": "أهلاً {name}",
            "howItWorks": "كيفاش خدام؟",
            "step1": "انشر طلبك",
            "step1Hint": "قول شنو محتاج وحدّد السعر",
            "step2": "الحرفيين يتنافسو",
            "step2Hint": "توصلك عروض من القريبين منك",
            "step3": "اختر وأكّد",
            "step3Hint": "تتبّع الحرفي حتى يوصل",
        },
        "catalog": {
            "popular": "الأكثر طلباً",
        },
        "providerHome": {
            "online": "متاح",
            "offline": "غير متاح",
            "availableNow": "أنت متاح لاستقبال الطلبات",
            "unavailableNow": "أنت غير متاح — لن تصلك طلبات",
            "nearbyRequests": "طلبات قريبة منك",
            "activeJob": "مهمة جارية",
            "todayEarnings": "مداخيل اليوم",
            "toggleHint": "بدّل حالتك باش تستقبل الطلبات",
        },
    },
    "en": {
        "home": {
            "greeting": "Hi {name}",
            "howItWorks": "How it works",
            "step1": "Post your request",
            "step1Hint": "Say what you need and set your price",
            "step2": "Craftsmen compete",
            "step2Hint": "Offers arrive from providers near you",
            "step3": "Pick and confirm",
            "step3Hint": "Track the craftsman until arrival",
        },
        "catalog": {
            "popular": "Most requested",
        },
        "providerHome": {
            "online": "Available",
            "offline": "Unavailable",
            "availableNow": "You are available for requests",
            "unavailableNow": "You are unavailable — no requests will arrive",
            "nearbyRequests": "Requests near you",
            "activeJob": "Active job",
            "todayEarnings": "Today's earnings",
            "toggleHint": "Toggle your status to receive requests",
        },
    },
    "fr": {
        "home": {
            "greeting": "Bonjour {name}",
            "howItWorks": "Comment ça marche",
            "step1": "Publiez votre demande",
            "step1Hint": "Dites ce dont vous avez besoin et fixez votre prix",
            "step2": "Les artisans concurrencent",
            "step2Hint": "Les offres arrivent des prestataires proches",
            "step3": "Choisissez et confirmez",
            "step3Hint": "Suivez l'artisan jusqu'à l'arrivée",
        },
        "catalog": {
            "popular": "Les plus demandés",
        },
        "providerHome": {
            "online": "Disponible",
            "offline": "Indisponible",
            "availableNow": "Vous êtes disponible pour des demandes",
            "unavailableNow": "Vous êtes indisponible — aucune demande n'arrivera",
            "nearbyRequests": "Demandes proches de vous",
            "activeJob": "Mission en cours",
            "todayEarnings": "Gains du jour",
            "toggleHint": "Changez votre statut pour recevoir des demandes",
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
