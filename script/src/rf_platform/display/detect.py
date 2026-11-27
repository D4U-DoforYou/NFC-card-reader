"""Automatic display protocol detection using read-only D1 discovery."""
from __future__ import annotations

from ..nfc.iso_dep import IsoDepSession
from .profiles import DISPLAY_PROFILES, DisplayScreen


class DisplayDetectionError(RuntimeError):
    pass


async def read_display_screen(
    session: IsoDepSession,
    profile: str = "auto",
) -> tuple[str, DisplayScreen, dict]:
    if profile != "auto":
        display_profile = DISPLAY_PROFILES.get(profile)
        if display_profile is None:
            raise ValueError("profile must be auto, huawei, or reink-c1")
        screen, info = await display_profile.read(session)
        return profile, screen, info

    failures = []
    for name, display_profile in DISPLAY_PROFILES.items():
        try:
            screen, info = await display_profile.read(session)
            info["profile"] = name
            return name, screen, info
        except display_profile.discovery_errors as exc:
            failures.append(f"{name}: {exc}")

    details = "; ".join(failures)
    raise DisplayDetectionError(
        f"unable to identify a supported display from D1 data ({details})"
    )
