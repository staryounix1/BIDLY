#!/usr/bin/env python3
"""Rename BIDLY -> Khdemli in the web i18n catalogs and add redesign keys.

Idempotent: safe to re-run. Rewrites the JSON files in place with a stable
key order (insertion order, 2-space indent, Arabic left unescaped).
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MESSAGES = ROOT / "apps" / "web" / "src" / "messages"

# New keys introduced by the inDrive-style redesign. `{count}` is interpolated
# by the translator, so the placeholder must survive translation.
NEW = {
    "ar": {
        "app": {
            "name": "Khdemli",
            "tagline": "اطلب أي خدمة، ودع الحرفيين يتنافسون",
            "copyright": "© {year} Khdemli — جميع الحقوق محفوظة",
        },
        "nav": {
            "signIn": "دخول",
            "signOut": "خروج",
        },
        "catalog": {
            "chooseService": "شنو محتاج اليوم؟",
            "chooseServiceHint": "اختر الخدمة، حدّد السعر، والحرفيين القريبين غادي يتنافسو",
            "searchPlaceholder": "قلّب على خدمة…",
            "all": "الكل",
            "availableServices": "الخدمات المتوفرة",
            "noResults": "ما لقيناش شي حاجة",
            "noResultsHint": "جرّب كلمة أخرى ولا اختار فئة مختلفة",
            "providersAvailable": "{count} حرفي متوفر",
            "noProvidersYet": "لا يوجد حرفي متوفر حالياً",
            "trustVerified": "حرفيين موثّقين",
            "trustVerifiedHint": "هوية متحقَّق منها",
            "trustPrice": "السعر بيدك",
            "trustPriceHint": "بلا وسيط",
        },
        "compose": {
            "title": "أنشئ طلبك",
            "destination": "الوجهة / تفاصيل الخدمة",
            "destinationPlaceholder": "مثال: إصلاح صنبور في الحمام",
            "yourPrice": "السعر المقترح",
            "sendRequest": "أرسل الطلب",
            "sending": "جارٍ الإرسال…",
            "priceHint": "عدّل السعر بـ + و −",
            "mapHint": "حدّد موقعك على الخريطة",
            "pickLocation": "حدّد الموقع",
        },
        "searching": {
            "looking": "جارٍ البحث عن حرفيين قريبين…",
            "elapsed": "مرّ {seconds} ثانية",
            "cancel": "إلغاء",
            "offersSoFar": "{count} عرض توصل",
            "viewOffers": "شوف العروض",
        },
        "offers": {
            "title": "العروض",
            "accept": "قبول",
            "decline": "تجاهل",
            "premium": "عضو Premium",
            "verified": "موثّق",
            "newOffers": "عروض جديدة",
            "empty": "ما توصل حتى عرض دابا",
            "emptyHint": "كنتسناو الحرفيين يردّو على طلبك",
        },
        "tracking": {
            "title": "تتبّع الحرفي",
            "eta": "يوصل فـ {minutes} دقيقة",
            "arrived": "وصل",
            "call": "اتصال",
            "message": "دردشة",
            "providerComing": "الحرفي في الطريق إليك",
        },
    },
    "en": {
        "app": {
            "name": "Khdemli",
            "tagline": "Request any service and let local craftsmen compete",
            "copyright": "© {year} Khdemli — All rights reserved",
        },
        "nav": {
            "signIn": "Sign in",
            "signOut": "Sign out",
        },
        "catalog": {
            "chooseService": "What do you need today?",
            "chooseServiceHint": "Pick a service, set your price, and nearby craftsmen compete",
            "searchPlaceholder": "Search a service…",
            "all": "All",
            "availableServices": "Available services",
            "noResults": "Nothing found",
            "noResultsHint": "Try another word or a different category",
            "providersAvailable": "{count} craftsmen available",
            "noProvidersYet": "No craftsman available right now",
            "trustVerified": "Verified craftsmen",
            "trustVerifiedHint": "Identity checked",
            "trustPrice": "You set the price",
            "trustPriceHint": "No middleman",
        },
        "compose": {
            "title": "Create your request",
            "destination": "Destination / service details",
            "destinationPlaceholder": "e.g. Fix a leaking tap in the bathroom",
            "yourPrice": "Your offer",
            "sendRequest": "Send request",
            "sending": "Sending…",
            "priceHint": "Adjust with + and −",
            "mapHint": "Set your location on the map",
            "pickLocation": "Set location",
        },
        "searching": {
            "looking": "Looking for nearby craftsmen…",
            "elapsed": "{seconds}s elapsed",
            "cancel": "Cancel",
            "offersSoFar": "{count} offers received",
            "viewOffers": "View offers",
        },
        "offers": {
            "title": "Offers",
            "accept": "Accept",
            "decline": "Decline",
            "premium": "Premium member",
            "verified": "Verified",
            "newOffers": "New offers",
            "empty": "No offers yet",
            "emptyHint": "Waiting for craftsmen to answer your request",
        },
        "tracking": {
            "title": "Track craftsman",
            "eta": "Arrives in {minutes} min",
            "arrived": "Arrived",
            "call": "Call",
            "message": "Chat",
            "providerComing": "Your craftsman is on the way",
        },
    },
    "fr": {
        "app": {
            "name": "Khdemli",
            "tagline": "Demandez un service et laissez les artisans concurrencer",
            "copyright": "© {year} Khdemli — Tous droits réservés",
        },
        "nav": {
            "signIn": "Connexion",
            "signOut": "Déconnexion",
        },
        "catalog": {
            "chooseService": "De quoi avez-vous besoin ?",
            "chooseServiceHint": "Choisissez un service, fixez votre prix, les artisans proches concurrencent",
            "searchPlaceholder": "Rechercher un service…",
            "all": "Tout",
            "availableServices": "Services disponibles",
            "noResults": "Aucun résultat",
            "noResultsHint": "Essayez un autre mot ou une autre catégorie",
            "providersAvailable": "{count} artisans disponibles",
            "noProvidersYet": "Aucun artisan disponible pour le moment",
            "trustVerified": "Artisans vérifiés",
            "trustVerifiedHint": "Identité contrôlée",
            "trustPrice": "Vous fixez le prix",
            "trustPriceHint": "Sans intermédiaire",
        },
        "compose": {
            "title": "Créer votre demande",
            "destination": "Destination / détails du service",
            "destinationPlaceholder": "ex. Réparer un robinet qui fuit",
            "yourPrice": "Votre offre",
            "sendRequest": "Envoyer la demande",
            "sending": "Envoi…",
            "priceHint": "Ajustez avec + et −",
            "mapHint": "Placez votre position sur la carte",
            "pickLocation": "Définir la position",
        },
        "searching": {
            "looking": "Recherche d'artisans proches…",
            "elapsed": "{seconds}s écoulées",
            "cancel": "Annuler",
            "offersSoFar": "{count} offres reçues",
            "viewOffers": "Voir les offres",
        },
        "offers": {
            "title": "Offres",
            "accept": "Accepter",
            "decline": "Refuser",
            "premium": "Membre Premium",
            "verified": "Vérifié",
            "newOffers": "Nouvelles offres",
            "empty": "Aucune offre pour le moment",
            "emptyHint": "En attente des réponses des artisans",
        },
        "tracking": {
            "title": "Suivre l'artisan",
            "eta": "Arrive dans {minutes} min",
            "arrived": "Arrivé",
            "call": "Appeler",
            "message": "Message",
            "providerComing": "Votre artisan est en route",
        },
    },
}

# Old strings that must not linger in user-visible copy.
BRAND_PATTERNS = [
    (re.compile(r"\bBIDLY\b", re.IGNORECASE), "Khdemli"),
]


def deep_merge(base: dict, extra: dict) -> dict:
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            deep_merge(base[key], value)
        else:
            base[key] = value
    return base


def rename_brand(node):
    if isinstance(node, dict):
        return {k: rename_brand(v) for k, v in node.items()}
    if isinstance(node, list):
        return [rename_brand(v) for v in node]
    if isinstance(node, str):
        for pattern, replacement in BRAND_PATTERNS:
            node = pattern.sub(replacement, node)
        return node
    return node


def main() -> int:
    for locale in ("ar", "en", "fr"):
        path = MESSAGES / f"{locale}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data = rename_brand(data)
        deep_merge(data, NEW[locale])
        data["app"]["name"] = "Khdemli"
        path.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"{locale}: {len(data)} top-level keys -> {path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
