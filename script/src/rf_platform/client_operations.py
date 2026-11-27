"""High-level RF and device operations built on the session client."""
from __future__ import annotations

from .client_errors import DeviceProtocolError
from .core.jobs import JobEvent, JobState
from .nfc.backend import ChipCommandResult, RawRfFrame
from .protocol import device_pb2
from .rf_modes import RfRxMode, RfTxMode
from .remote_job import RemoteJob, _require_completed, _to_job_event


class DeviceOperationsMixin:
    """Implements device commands on top of DeviceClient's request channel."""

    async def start_job(
        self,
        capability_id: str,
        operation_id: str,
        arguments: bytes = b"",
        *,
        capability_major: int = 1,
        deadline_ms: int = 30_000,
        idempotency_key: bytes = b"",
        confirmed_target_uid: bytes = b"",
    ) -> RemoteJob:
        request = device_pb2.StartJob(
            capability_id=capability_id,
            capability_major=capability_major,
            operation_id=operation_id,
            arguments=arguments,
            deadline_ms=deadline_ms,
            idempotency_key=idempotency_key,
            user_confirmed=bool(confirmed_target_uid),
            confirmed_target_uid=confirmed_target_uid,
        )
        response = await self._request("start_job", request, "job_event")
        accepted = _to_job_event(response.job_event)
        if accepted.state != JobState.ACCEPTED:
            detail = accepted.detail or "start_job did not return ACCEPTED"
            raise DeviceProtocolError(detail)
        event_queue = self._claim_job_events(accepted.job_id)
        return RemoteJob(
            self, accepted, event_queue, timeout=deadline_ms / 1000 + 1
        )

    async def get_tx_amplitude(self) -> int:
        result = await self._run_job(
            "org.example.rf.clrc663.config", "get_tx_amplitude"
        )
        return device_pb2.TxAmplitudeResult.FromString(result).level

    async def set_tx_amplitude(self, level: int) -> int:
        if not 0 <= level <= 3:
            raise ValueError("transmit amplitude level must be between 0 and 3")
        arguments = device_pb2.TxAmplitudeRequest(level=level).SerializeToString()
        result = await self._run_job(
            "org.example.rf.clrc663.config",
            "set_tx_amplitude",
            arguments,
        )
        return device_pb2.TxAmplitudeResult.FromString(result).level

    async def set_rf_field(self, enabled: bool) -> None:
        arguments = device_pb2.RfFieldRequest(
            enabled=enabled
        ).SerializeToString()
        await self._run_job(
            "org.example.rf.raw", "set_field", arguments, deadline_ms=5_000
        )

    async def raw_transceive(
        self,
        tx: bytes,
        *,
        rx_mode: RfRxMode | int | None = None,
        tx_mode: RfTxMode | int | None = None,
        timeout_ms: int = 25,
        tx_last_bits: int = 0,
        rx_align: int = 0,
        crc_flags: int = 3,
        confirmed_target_uid: bytes = b"",
    ) -> RawRfFrame:
        if not 1 <= len(tx) <= 256:
            raise ValueError("raw RF frame must contain 1..256 bytes")
        if not 1 <= timeout_ms <= 300_000:
            raise ValueError("raw RF timeout must be between 1 and 300000 ms")
        if not 0 <= tx_last_bits <= 7 or not 0 <= rx_align <= 7:
            raise ValueError("raw RF bit counts must be between 0 and 7")
        if not 0 <= crc_flags <= 3:
            raise ValueError("raw RF CRC flags must be between 0 and 3")
        try:
            receive_mode = RfRxMode(
                RfRxMode.ISO14443A_106
                if rx_mode is None else rx_mode
            )
            transmit_mode = None if tx_mode is None else RfTxMode(tx_mode)
        except (TypeError, ValueError) as exc:
            raise ValueError("unsupported CLRC663 RX/TX mode") from exc

        if (
            receive_mode != RfRxMode.ISO14443A_106
            or transmit_mode not in (None, RfTxMode.ISO14443A_106)
        ):
            raw_capability = self._find_capability("org.example.rf.raw")
            if (
                raw_capability is None
                or raw_capability.major_version != 1
                or raw_capability.minor_version < 1
            ):
                raise DeviceProtocolError(
                    "device firmware does not support explicit CLRC663 RF modes"
                )

        request = device_pb2.RawRfTransceiveRequest(
            tx=tx,
            timeout_ms=timeout_ms,
            tx_last_bits=tx_last_bits,
            rx_align=rx_align,
            crc_flags=crc_flags,
            rx_mode=int(receive_mode),
        )
        if transmit_mode is not None:
            request.tx_mode = int(transmit_mode)
        arguments = request.SerializeToString()
        deadline_ms = min(300_000, max(5_000, timeout_ms + 5_000))
        result_data = await self._run_job(
            "org.example.rf.raw",
            "transceive",
            arguments,
            deadline_ms=deadline_ms,
            confirmed_target_uid=confirmed_target_uid,
        )
        result = device_pb2.RawRfTransceiveResult.FromString(result_data)
        return RawRfFrame(
            rx=bytes(result.rx),
            rx_last_bits=result.rx_last_bits,
            irq0=result.irq0,
            irq1=result.irq1,
            error=result.error,
            collision=result.collision,
        )

    def _require_chip_primitive_support(self) -> None:
        capability = self._find_capability("org.example.rf.raw")
        if (
            capability is None
            or capability.major_version != 1
            or capability.minor_version < 2
        ):
            raise DeviceProtocolError(
                "device firmware does not support CLRC663 chip primitives"
            )

    def _find_capability(
        self, capability_id: str
    ) -> device_pb2.CapabilityDescriptor | None:
        return next(
            (item for item in self.capabilities if item.id == capability_id),
            None,
        )

    async def _run_job(
        self,
        capability_id: str,
        operation_id: str,
        arguments: bytes = b"",
        *,
        deadline_ms: int = 30_000,
        confirmed_target_uid: bytes = b"",
    ) -> bytes:
        job = await self.start_job(
            capability_id,
            operation_id,
            arguments,
            deadline_ms=deadline_ms,
            confirmed_target_uid=confirmed_target_uid,
        )
        event = await job.wait()
        _require_completed(event)
        return event.result

    async def execute_chip_command(
        self,
        command: int,
        fifo_input: bytes = b"",
        *,
        timeout_ms: int = 25,
        confirmed_target_uid: bytes,
    ) -> ChipCommandResult:
        self._require_chip_primitive_support()
        if not 0 <= command <= 0x1F:
            raise ValueError("CLRC663 command must be between 0 and 31")
        if len(fifo_input) > 256:
            raise ValueError("CLRC663 command FIFO input is limited to 256 bytes")
        if not 1 <= timeout_ms <= 300_000:
            raise ValueError("CLRC663 timeout must be between 1 and 300000 ms")
        if len(confirmed_target_uid) not in (4, 7, 10):
            raise ValueError("chip commands require a selected card UID")

        arguments = device_pb2.Clrc663CommandRequest(
            command=command,
            fifo_input=fifo_input,
            timeout_ms=timeout_ms,
        ).SerializeToString()
        result_data = await self._run_job(
            "org.example.rf.raw",
            "execute_command",
            arguments,
            deadline_ms=min(300_000, max(5_000, timeout_ms + 5_000)),
            confirmed_target_uid=confirmed_target_uid,
        )
        result = device_pb2.Clrc663CommandResult.FromString(result_data)
        return ChipCommandResult(
            fifo_output=bytes(result.fifo_output),
            irq0=result.irq0,
            irq1=result.irq1,
            error=result.error,
            status=result.status,
        )

    async def read_chip_register(self, address: int) -> int:
        self._require_chip_primitive_support()
        if not 0 <= address <= 0x7F:
            raise ValueError("CLRC663 register address must be between 0 and 127")
        arguments = device_pb2.Clrc663RegisterRequest(
            address=address
        ).SerializeToString()
        result_data = await self._run_job(
            "org.example.rf.raw", "read_register", arguments
        )
        result = device_pb2.Clrc663RegisterResult.FromString(result_data)
        return result.value

    async def write_chip_register(self, address: int, value: int) -> None:
        self._require_chip_primitive_support()
        if not 0 <= address <= 0x7F or not 0 <= value <= 0xFF:
            raise ValueError("invalid CLRC663 register address or value")
        writable = (
            address == 0x0B and value == 0
            or 0x14 <= address <= 0x27
            or 0x2B <= address <= 0x39 and address != 0x2E
        )
        if not writable:
            raise ValueError("CLRC663 register is owned by the RF driver")
        arguments = device_pb2.Clrc663RegisterRequest(
            address=address,
            value=value,
        ).SerializeToString()
        await self._run_job(
            "org.example.rf.raw", "write_register", arguments
        )

    async def cancel_job(self, job_id: int) -> JobEvent:
        response = await self._request(
            "cancel_job",
            device_pb2.CancelJob(job_id=job_id),
            "job_event",
        )
        return _to_job_event(response.job_event)

    async def query_job(self, job_id: int) -> JobEvent:
        response = await self._request(
            "query_job",
            device_pb2.QueryJob(job_id=job_id),
            "job_event",
        )
        return _to_job_event(response.job_event)

