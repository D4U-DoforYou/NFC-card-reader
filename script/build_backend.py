"""Setuptools backend that generates Python protobuf bindings before builds."""

from pathlib import Path
import os

from grpc_tools import protoc
from setuptools import build_meta as _build_meta


ROOT = Path(__file__).parent
PROTO = ROOT / "protocol" / "device.proto"
OUTPUT = ROOT / "src" / "rf_platform" / "protocol"


def _run_backend(hook, *args):
    previous_directory = Path.cwd()
    os.chdir(ROOT)
    try:
        return hook(*args)
    finally:
        os.chdir(previous_directory)


def _generate_protocol() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "__init__.py").touch(exist_ok=True)
    result = protoc.main(
        [
            "grpc_tools.protoc",
            f"--proto_path={PROTO.parent}",
            f"--python_out={OUTPUT}",
            str(PROTO),
        ]
    )
    if result != 0:
        raise RuntimeError(f"protoc failed with exit code {result}")


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    _generate_protocol()
    return _run_backend(
        _build_meta.build_wheel, wheel_directory, config_settings, metadata_directory
    )


def build_editable(wheel_directory, config_settings=None, metadata_directory=None):
    _generate_protocol()
    return _run_backend(
        _build_meta.build_editable, wheel_directory, config_settings, metadata_directory
    )


def build_sdist(sdist_directory, config_settings=None):
    _generate_protocol()
    return _run_backend(_build_meta.build_sdist, sdist_directory, config_settings)


def prepare_metadata_for_build_wheel(metadata_directory, config_settings=None):
    return _run_backend(
        _build_meta.prepare_metadata_for_build_wheel, metadata_directory, config_settings
    )


def get_requires_for_build_wheel(config_settings=None):
    return _run_backend(_build_meta.get_requires_for_build_wheel, config_settings)


def get_requires_for_build_sdist(config_settings=None):
    return _run_backend(_build_meta.get_requires_for_build_sdist, config_settings)


def get_requires_for_build_editable(config_settings=None):
    return _run_backend(_build_meta.get_requires_for_build_editable, config_settings)


def prepare_metadata_for_build_editable(metadata_directory, config_settings=None):
    return _run_backend(
        _build_meta.prepare_metadata_for_build_editable,
        metadata_directory,
        config_settings,
    )
