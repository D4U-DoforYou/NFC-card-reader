"""Static capability contracts and host-side capability registration."""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Protocol


_CAPABILITY_ID = re.compile(
    r"^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*){2,}$"
)
_OPERATION_ID = re.compile(r"^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$")


@dataclass(frozen=True, slots=True)
class OperationDescriptor:
    operation_id: str
    mutating: bool = False
    cancellable: bool = True
    max_payload_size: int = 4096
    requires_target_confirmation: bool = False

    def __post_init__(self) -> None:
        if not _OPERATION_ID.fullmatch(self.operation_id):
            raise ValueError("operation ID must be a lowercase local identifier")
        if self.max_payload_size < 0:
            raise ValueError("max_payload_size must be non-negative")
        if self.requires_target_confirmation and not self.mutating:
            raise ValueError("target confirmation requires a mutating operation")


@dataclass(frozen=True, slots=True)
class CapabilityRequirement:
    capability_id: str
    minimum_major: int = 1

    def __post_init__(self) -> None:
        _validate_id(self.capability_id, "capability")
        if self.minimum_major < 1:
            raise ValueError("minimum_major must be positive")


@dataclass(frozen=True, slots=True)
class CapabilityDescriptor:
    capability_id: str
    major_version: int
    minor_version: int
    operations: tuple[OperationDescriptor, ...]
    requirements: tuple[CapabilityRequirement, ...] = ()

    def __post_init__(self) -> None:
        _validate_id(self.capability_id, "capability")
        if self.major_version < 1 or self.minor_version < 0:
            raise ValueError("invalid capability version")
        operation_ids = [item.operation_id for item in self.operations]
        if len(operation_ids) != len(set(operation_ids)):
            raise ValueError("operation IDs must be unique within a capability")
        requirement_ids = [item.capability_id for item in self.requirements]
        if len(requirement_ids) != len(set(requirement_ids)):
            raise ValueError("capability requirements must be unique")

    def operation(self, operation_id: str) -> OperationDescriptor:
        for operation in self.operations:
            if operation.operation_id == operation_id:
                return operation
        raise KeyError(
            f"unsupported operation {operation_id!r} on {self.capability_id!r}"
        )


class CapabilityModule(Protocol):
    @property
    def descriptor(self) -> CapabilityDescriptor: ...


class CapabilityRegistry:
    """Register host-side modules and validate their declared dependencies."""

    def __init__(self) -> None:
        self._modules: dict[str, CapabilityModule] = {}

    def register(self, module: CapabilityModule) -> None:
        descriptor = module.descriptor
        capability_id = descriptor.capability_id
        if capability_id in self._modules:
            raise ValueError(f"duplicate capability {capability_id!r}")
        self._modules[capability_id] = module

    def get(self, capability_id: str) -> CapabilityModule:
        try:
            return self._modules[capability_id]
        except KeyError as exc:
            raise KeyError(f"capability {capability_id!r} is not registered") from exc

    def descriptors(self) -> tuple[CapabilityDescriptor, ...]:
        return tuple(module.descriptor for module in self._modules.values())

    def missing_requirements(
        self,
        available: dict[str, int],
    ) -> tuple[tuple[str, str, int], ...]:
        missing = []
        for descriptor in self.descriptors():
            for requirement in descriptor.requirements:
                version = available.get(requirement.capability_id)
                if version is None or version < requirement.minimum_major:
                    missing.append((
                        descriptor.capability_id,
                        requirement.capability_id,
                        requirement.minimum_major,
                    ))
        return tuple(missing)


def _validate_id(value: str, label: str) -> None:
    if not _CAPABILITY_ID.fullmatch(value):
        raise ValueError(f"{label} ID must be a lowercase namespaced identifier")
