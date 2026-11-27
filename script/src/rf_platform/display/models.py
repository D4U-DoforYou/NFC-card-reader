"""Shared display image configuration types."""
from dataclasses import dataclass
from enum import Enum


class ImageAlgorithm(str, Enum):
    ATKINSON = "atkinson"
    FLOYD = "floyd"
    COLOR = "color"
    GRAYSCALE = "grayscale"


@dataclass(frozen=True, slots=True)
class ImageOptions:
    algorithm: ImageAlgorithm = ImageAlgorithm.ATKINSON
    fit: str = "contain"
    rotation: int = 0
    brightness: float = 1.0
    contrast: float = 1.0
    scale: float = 100.0
    black_white: bool = False
