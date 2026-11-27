"""Host-side display protocols and image preparation."""

from .detect import DisplayDetectionError, read_display_screen
from .huawei import (
    DEFAULT_PIN,
    HuaweiError,
    HuaweiScreen,
    ImageAlgorithm,
    ImageOptions,
    PreparedHuaweiImage,
    prepare_huawei_image,
    read_huawei_screen,
    refresh_huawei_screen,
)
from .reink_c1 import (
    PreparedReinkC1Image,
    ReinkC1Error,
    ReinkC1Screen,
    prepare_reink_c1_image,
    read_reink_c1_screen,
    refresh_reink_c1_screen,
)

__all__ = [
    "DEFAULT_PIN",
    "HuaweiError",
    "HuaweiScreen",
    "ImageAlgorithm",
    "ImageOptions",
    "PreparedHuaweiImage",
    "prepare_huawei_image",
    "read_huawei_screen",
    "refresh_huawei_screen",
    "DisplayDetectionError",
    "read_display_screen",
    "PreparedReinkC1Image",
    "ReinkC1Error",
    "ReinkC1Screen",
    "prepare_reink_c1_image",
    "read_reink_c1_screen",
    "refresh_reink_c1_screen",
]
