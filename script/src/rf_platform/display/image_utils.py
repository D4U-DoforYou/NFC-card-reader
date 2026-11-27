"""Shared image geometry helpers for supported displays."""
from PIL import Image, ImageOps


def fit_image(
    image: Image.Image,
    size: tuple[int, int],
    *,
    fit: str,
    rotation: int,
) -> Image.Image:
    if fit not in ("contain", "cover"):
        raise ValueError("fit must be contain or cover")
    if rotation not in (0, 90, 180, 270):
        raise ValueError("rotation must be 0, 90, 180, or 270")

    background = Image.new("RGBA", image.size, "white")
    source = Image.alpha_composite(background, image).convert("RGB")
    source = source.rotate(rotation, expand=True)
    if fit == "cover":
        return ImageOps.fit(source, size, method=Image.Resampling.LANCZOS)

    fitted = ImageOps.contain(source, size, method=Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", size, "white")
    canvas.paste(fitted, ((size[0] - fitted.width) // 2,
                          (size[1] - fitted.height) // 2))
    return canvas
