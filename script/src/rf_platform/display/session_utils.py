"""Shared display session cleanup helpers."""
from ..nfc.iso_dep import IsoDepSession


async def deactivate_quietly(session: IsoDepSession) -> None:
    try:
        await session.deactivate()
    except Exception:
        pass
