"""Display profile implementations shared by discovery and web sessions."""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable

from ..nfc.iso_dep import IsoDepSession, NfcProtocolError
from .huawei import (
    HuaweiError,
    HuaweiScreen,
    PreparedHuaweiImage,
    prepare_huawei_image,
    read_huawei_screen,
    refresh_huawei_screen,
)
from .models import ImageAlgorithm, ImageOptions
from .reink_c1 import (
    PreparedReinkC1Image,
    ReinkC1Error,
    ReinkC1Screen,
    prepare_reink_c1_image,
    read_reink_c1_screen,
    refresh_reink_c1_screen,
)


DisplayScreen = HuaweiScreen | ReinkC1Screen
PreparedDisplayImage = PreparedHuaweiImage | PreparedReinkC1Image
DisplayProgress = Callable[[str, int, int], None]


class DisplayProfile(ABC):
    name: str
    product_name: str
    default_algorithm: ImageAlgorithm
    discovery_errors: tuple[type[Exception], ...]

    @abstractmethod
    async def read(self, session: IsoDepSession) -> tuple[DisplayScreen, dict]:
        raise NotImplementedError

    @abstractmethod
    def prepare(
        self, image: bytes, screen: DisplayScreen, options: ImageOptions
    ) -> PreparedDisplayImage:
        raise NotImplementedError

    @abstractmethod
    async def refresh(
        self,
        session: IsoDepSession,
        screen: DisplayScreen,
        prepared: PreparedDisplayImage,
        *,
        pin: bytes,
        upload_only: bool,
        progress: DisplayProgress,
    ) -> None:
        raise NotImplementedError


class HuaweiDisplayProfile(DisplayProfile):
    name = "huawei"
    product_name = "Huawei"
    default_algorithm = ImageAlgorithm.ATKINSON
    discovery_errors = (HuaweiError, NfcProtocolError)

    async def read(self, session: IsoDepSession) -> tuple[HuaweiScreen, dict]:
        return await read_huawei_screen(session)

    def prepare(
        self, image: bytes, screen: DisplayScreen, options: ImageOptions
    ) -> PreparedHuaweiImage:
        if not isinstance(screen, HuaweiScreen):
            raise TypeError("Huawei profile requires a Huawei screen")
        return prepare_huawei_image(image, options)

    async def refresh(
        self,
        session: IsoDepSession,
        screen: DisplayScreen,
        prepared: PreparedDisplayImage,
        *,
        pin: bytes,
        upload_only: bool,
        progress: DisplayProgress,
    ) -> None:
        if not isinstance(screen, HuaweiScreen) or not isinstance(
            prepared, PreparedHuaweiImage
        ):
            raise TypeError(
                "Huawei refresh requires Huawei screen and image data"
            )
        await refresh_huawei_screen(
            session,
            screen,
            prepared,
            pin=pin,
            upload_only=upload_only,
            progress=progress,
        )


class ReinkC1DisplayProfile(DisplayProfile):
    name = "reink-c1"
    product_name = "Reink Case C1"
    default_algorithm = ImageAlgorithm.COLOR
    discovery_errors = (ReinkC1Error, NfcProtocolError)

    async def read(self, session: IsoDepSession) -> tuple[ReinkC1Screen, dict]:
        return await read_reink_c1_screen(session)

    def prepare(
        self, image: bytes, screen: DisplayScreen, options: ImageOptions
    ) -> PreparedReinkC1Image:
        if not isinstance(screen, ReinkC1Screen):
            raise TypeError("Reink C1 profile requires a C1 screen")
        return prepare_reink_c1_image(image, screen, options)

    async def refresh(
        self,
        session: IsoDepSession,
        screen: DisplayScreen,
        prepared: PreparedDisplayImage,
        *,
        pin: bytes,
        upload_only: bool,
        progress: DisplayProgress,
    ) -> None:
        if not isinstance(screen, ReinkC1Screen) or not isinstance(
            prepared, PreparedReinkC1Image
        ):
            raise TypeError("C1 refresh requires C1 screen and image data")
        await refresh_reink_c1_screen(
            session,
            screen,
            prepared,
            pin=pin,
            upload_only=upload_only,
            progress=progress,
        )


DISPLAY_PROFILES: dict[str, DisplayProfile] = {
    profile.name: profile
    for profile in (HuaweiDisplayProfile(), ReinkC1DisplayProfile())
}
