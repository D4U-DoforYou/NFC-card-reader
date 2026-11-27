"""Local web interface for the RF device host client."""
from __future__ import annotations

import base64
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field
from starlette.requests import Request

from .display.huawei import DEFAULT_PIN
from .display.models import ImageAlgorithm, ImageOptions
from .display.profiles import DISPLAY_PROFILES

from .web_session import DeviceSession


_WEB_DIRECTORY = Path(__file__).resolve().parent / "web"


class ConnectRequest(BaseModel):
    device: str | None = None


class AmplitudeRequest(BaseModel):
    level: int = Field(ge=0, le=3)


class ImagePreviewRequest(BaseModel):
    image: str = Field(max_length=28_000_000)
    profile: str = "auto"
    fit: str = "contain"
    rotation: int = 0
    algorithm: ImageAlgorithm | None = None


class DisplayScanRequest(BaseModel):
    profile: str = "auto"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.device = DeviceSession()
    yield
    await app.state.device.disconnect()


app = FastAPI(title="RF Device Control", lifespan=lifespan)


@app.middleware("http")
async def reject_cross_origin_posts(request: Request, call_next):
    origin = request.headers.get("origin")
    if request.method == "POST" and origin is not None:
        expected_origin = str(request.base_url).rstrip("/")
        if origin != expected_origin:
            return JSONResponse(
                {"detail": "cross-origin requests are not allowed"},
                status_code=403,
            )
    return await call_next(request)


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(_WEB_DIRECTORY / "index.html")


@app.get("/api/status")
async def get_status() -> dict:
    return app.state.device.status()


@app.post("/api/connect")
async def connect_device(request: ConnectRequest) -> dict:
    try:
        return await app.state.device.connect(request.device)
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/disconnect")
async def disconnect_device() -> dict:
    return await app.state.device.disconnect()


@app.get("/api/amplitude")
async def get_amplitude() -> dict:
    try:
        level = await app.state.device.read_amplitude()
        return {"level": level}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/amplitude")
async def set_amplitude(request: AmplitudeRequest) -> dict:
    try:
        level = await app.state.device.set_amplitude(request.level)
        return {"level": level}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/scan/type-a")
async def scan_type_a() -> dict:
    try:
        return await app.state.device.scan_type_a()
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/display/preview")
async def preview_display_image(request: ImagePreviewRequest) -> Response:
    try:
        image = base64.b64decode(request.image, validate=True)
        detected_profile = app.state.device.display_profile
        profile = request.profile
        if profile == "auto":
            profile = detected_profile
        if profile is None or profile != detected_profile:
            raise ValueError("scan the screen before generating its preview")
        options = ImageOptions(
            algorithm=(
                request.algorithm
                or DISPLAY_PROFILES[profile].default_algorithm
            ),
            fit=request.fit,
            rotation=request.rotation,
        )
        preview_png = app.state.device.prepare_display_preview(image, options)
        return Response(preview_png, media_type="image/png")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/display/scan")
async def scan_display(request: DisplayScanRequest | None = None) -> dict:
    try:
        profile = request.profile if request is not None else "auto"
        return await app.state.device.scan_display(profile)
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/display/refresh")
async def refresh_huawei_display(
    image: UploadFile = File(...),
    confirmed_uid: str = Form(...),
    pin: str = Form(""),
    fit: str = Form("contain"),
    rotation: int = Form(0),
    algorithm: ImageAlgorithm | None = Form(None),
    upload_only: bool = Form(False),
    profile: str = Form("auto"),
) -> dict:
    try:
        image_data = await image.read(20 * 1024 * 1024 + 1)
        if len(image_data) > 20 * 1024 * 1024:
            raise ValueError("image file exceeds 20 MiB")
        pin_bytes = DEFAULT_PIN if not pin else bytes.fromhex(pin)
        if len(pin_bytes) != 5:
            raise ValueError("PIN must be exactly 5 bytes of hexadecimal")
        detected_profile = app.state.device.display_profile
        if detected_profile is None:
            raise RuntimeError("scan a display before starting an update")
        if profile not in ("auto", detected_profile):
            raise ValueError("requested profile does not match the scanned display")
        profile = detected_profile
        arguments = {
            "image": image_data,
            "confirmed_uid": confirmed_uid,
            "pin": pin_bytes,
            "fit": fit,
            "rotation": rotation,
            "algorithm": (
                algorithm or DISPLAY_PROFILES[profile].default_algorithm
            ),
            "upload_only": upload_only,
        }
        return app.state.device.start_display_refresh(
            profile=profile, **arguments
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/display/status")
async def get_huawei_display_status() -> dict:
    return app.state.device.display_status()


@app.post("/api/display/stop")
async def stop_huawei_display_session() -> dict:
    try:
        await app.state.device.deactivate_display()
        return {"deactivated": True}
    except Exception as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def main() -> None:
    import uvicorn

    uvicorn.run("rf_platform.web_app:app", host="127.0.0.1", port=8000)
