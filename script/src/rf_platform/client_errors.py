"""Errors raised by the host protocol client."""


class DeviceProtocolError(RuntimeError):
    """The device returned a response that violates the protocol contract."""


class DeviceConnectionError(ConnectionError):
    """The device transport or protocol session is unavailable."""
