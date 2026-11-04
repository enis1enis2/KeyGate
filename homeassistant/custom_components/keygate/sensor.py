"""Sensor entities for KeyGate."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .coordinator import KeyGateCoordinator
from .entity import async_prune_stale_entities, hub_device, sub_device

ValueFn = Callable[[dict[str, Any]], Any]


def _pool_usage(data: dict[str, Any], alias: str) -> dict[str, Any]:
    return (data.get("pool_usage") or {}).get(alias) or {}


def _current_pool(data: dict[str, Any], alias: str) -> dict[str, Any]:
    """Return the pool row from the latest poll so caps can change at runtime."""
    for pool in data.get("pools") or []:
        if pool.get("alias_name") == alias:
            return pool
    return {}


def _num(value: Any) -> Any:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class _KeyGateSensor(CoordinatorEntity[KeyGateCoordinator], SensorEntity):
    """Base sensor bound to a value function over the coordinator payload."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self,
        coordinator: KeyGateCoordinator,
        unique_suffix: str,
        name: str,
        value_fn: ValueFn,
        device_info: DeviceInfo,
        *,
        unit: str | None = None,
        device_class: SensorDeviceClass | None = None,
        state_class: SensorStateClass | None = None,
        icon: str | None = None,
        entity_category: EntityCategory | None = None,
        options: list[str] | None = None,
        suggested_display_precision: int | None = None,
    ) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{unique_suffix}"
        self._attr_name = name
        self._attr_native_unit_of_measurement = unit
        self._attr_device_class = device_class
        self._attr_state_class = state_class
        self._attr_icon = icon
        self._attr_entity_category = entity_category
        self._attr_options = options
        if suggested_display_precision is not None:
            self._attr_suggested_display_precision = suggested_display_precision
        self._value_fn = value_fn
        self._device_info = device_info

    @property
    def device_info(self) -> DeviceInfo:
        return self._device_info

    @property
    def native_value(self) -> Any:
        if not self.coordinator.data:
            return None
        return self._value_fn(self.coordinator.data)


def _global_specs() -> list[dict[str, Any]]:
    return [
        {"key": "total_requests", "name": "Total requests (24h)", "fn": lambda d: _num(d["stats"].get("totalRequests")), "icon": "mdi:counter", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "success_requests", "name": "Successful requests (24h)", "fn": lambda d: _num(d["stats"].get("successRequests")), "icon": "mdi:check-circle", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "error_requests", "name": "Failed requests (24h)", "fn": lambda d: _num(d["stats"].get("errorRequests")), "icon": "mdi:alert-circle", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "success_rate", "name": "Success rate", "fn": lambda d: _num(d["stats"].get("successRate")), "unit": "%", "state_class": SensorStateClass.MEASUREMENT, "icon": "mdi:percent"},
        {"key": "avg_latency", "name": "Average latency", "fn": lambda d: _num(d["stats"].get("avgLatencyMs")), "unit": "ms", "device_class": SensorDeviceClass.DURATION, "icon": "mdi:timer-outline"},
        {"key": "p50_latency", "name": "p50 latency", "fn": lambda d: _num(d["stats"].get("p50LatencyMs")), "unit": "ms", "device_class": SensorDeviceClass.DURATION, "icon": "mdi:timer-outline"},
        {"key": "p95_latency", "name": "p95 latency", "fn": lambda d: _num(d["stats"].get("p95LatencyMs")), "unit": "ms", "device_class": SensorDeviceClass.DURATION, "icon": "mdi:timer-outline"},
        {"key": "prompt_tokens", "name": "Prompt tokens (24h)", "fn": lambda d: _num(d["stats"].get("totalPromptTokens")), "icon": "mdi:format-text", "state_class": SensorStateClass.TOTAL_INCREASING},
        {"key": "completion_tokens", "name": "Completion tokens (24h)", "fn": lambda d: _num(d["stats"].get("totalCompletionTokens")), "icon": "mdi:format-text", "state_class": SensorStateClass.TOTAL_INCREASING},
        {"key": "total_tokens", "name": "Total tokens (24h)", "fn": lambda d: _num((d["stats"].get("totalPromptTokens") or 0) + (d["stats"].get("totalCompletionTokens") or 0)), "icon": "mdi:counter", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "spend_today", "name": "Spend today", "fn": lambda d: _num(d["stats"].get("spendToday")), "unit": "USD", "device_class": SensorDeviceClass.MONETARY, "icon": "mdi:cash", "precision": 4},
        {"key": "total_keys", "name": "Upstream keys", "fn": lambda d: _num(d["stats"].get("totalKeys")), "icon": "mdi:key-variant", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "active_keys", "name": "Active upstream keys", "fn": lambda d: _num(d["stats"].get("activeKeys")), "icon": "mdi:key-check", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "total_providers", "name": "Providers", "fn": lambda d: _num(d["stats"].get("totalProviders")), "icon": "mdi:server", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "total_pools", "name": "Pools", "fn": lambda d: float(len(d.get("pools") or [])), "icon": "mdi:pool", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "active_pools", "name": "Active pools", "fn": lambda d: float(sum(1 for p in d.get("pools") or [] if p.get("is_active"))), "icon": "mdi:pool", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "total_gateway_keys", "name": "Gateway keys", "fn": lambda d: float(len(d.get("gateway_keys") or [])), "icon": "mdi:key-chain", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "active_gateway_keys", "name": "Active gateway keys", "fn": lambda d: float(sum(1 for k in d.get("gateway_keys") or [] if k.get("is_active"))), "icon": "mdi:key-chain-variant", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "circuits_closed", "name": "Circuits closed", "fn": lambda d: _num((d["stats"].get("circuits") or {}).get("closed")), "icon": "mdi:circuit-chip", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "circuits_half_open", "name": "Circuits half-open", "fn": lambda d: _num((d["stats"].get("circuits") or {}).get("halfOpen")), "icon": "mdi:circuit-chip", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "circuits_open", "name": "Circuits open", "fn": lambda d: _num((d["stats"].get("circuits") or {}).get("open")), "icon": "mdi:circuit-chip", "state_class": SensorStateClass.MEASUREMENT},
        {"key": "uptime", "name": "Uptime", "fn": lambda d: _num(d["health"].get("uptimeSeconds")), "unit": "s", "device_class": SensorDeviceClass.DURATION, "icon": "mdi:clock-outline"},
        {"key": "health_status", "name": "Health status", "fn": lambda d: d["health"].get("status"), "icon": "mdi:heart-pulse"},
        {"key": "database_status", "name": "Database status", "fn": lambda d: d["health"].get("database"), "icon": "mdi:database", "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "pools_over_budget", "name": "Pools over budget", "fn": _pools_over_budget, "icon": "mdi:alert-octagon", "state_class": SensorStateClass.MEASUREMENT},
    ]


def _pools_over_budget(data: dict[str, Any]) -> float:
    count = 0
    for pool in data.get("pools") or []:
        usage = _pool_usage(data, pool.get("alias_name"))
        token_cap = pool.get("daily_token_cap") or 0
        spend_cap = pool.get("daily_spend_cap") or 0
        if token_cap and (usage.get("tokens") or 0) >= token_cap:
            count += 1
        elif spend_cap and (usage.get("spend") or 0) >= spend_cap:
            count += 1
    return float(count)


def _pool_metrics(alias: str) -> list[dict[str, Any]]:
    """Return the per-pool sensors for *alias*.

    Every value function re-reads the pool row from the current coordinator payload, so a cap,
    strategy or timeout changed in the KeyGate UI is reflected on the next poll instead of being
    frozen at entity-creation time.
    """

    def usage(d: dict[str, Any]) -> dict[str, Any]:
        return _pool_usage(d, alias)

    def pool(d: dict[str, Any]) -> dict[str, Any]:
        return _current_pool(d, alias)

    def token_pct(d: dict[str, Any]) -> Any:
        cap = pool(d).get("daily_token_cap") or 0
        if not cap:
            return None
        return round((usage(d).get("tokens") or 0) / cap * 100, 1)

    def spend_pct(d: dict[str, Any]) -> Any:
        cap = pool(d).get("daily_spend_cap") or 0
        if not cap:
            return None
        return round((usage(d).get("spend") or 0) / cap * 100, 1)

    return [
        {"key": "spend_today", "name": "Spend today", "fn": lambda d: _num(usage(d).get("spend")), "unit": "USD", "device_class": SensorDeviceClass.MONETARY, "precision": 4},
        {"key": "tokens_today", "name": "Tokens today", "fn": lambda d: _num(usage(d).get("tokens")), "icon": "mdi:counter"},
        {"key": "requests_today", "name": "Requests today", "fn": lambda d: _num(usage(d).get("requests")), "icon": "mdi:counter"},
        {"key": "daily_token_cap", "name": "Daily token cap", "fn": lambda d: _num(pool(d).get("daily_token_cap")), "icon": "mdi:gauge", "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "daily_spend_cap", "name": "Daily spend cap", "fn": lambda d: _num(pool(d).get("daily_spend_cap")), "unit": "USD", "device_class": SensorDeviceClass.MONETARY, "entity_category": EntityCategory.DIAGNOSTIC, "precision": 4},
        {"key": "token_budget_used", "name": "Token budget used", "fn": token_pct, "unit": "%", "state_class": SensorStateClass.MEASUREMENT, "icon": "mdi:gauge"},
        {"key": "spend_budget_used", "name": "Spend budget used", "fn": spend_pct, "unit": "%", "state_class": SensorStateClass.MEASUREMENT, "icon": "mdi:gauge"},
        {"key": "targets_count", "name": "Targets", "fn": lambda d: float(len(pool(d).get("targets") or [])), "icon": "mdi:target", "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "strategy", "name": "Routing strategy", "fn": lambda d: pool(d).get("strategy"), "icon": "mdi:shuffle-variant", "device_class": SensorDeviceClass.ENUM, "options": ["weighted-by-health", "round-robin", "priority", "by-ai"], "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "endpoint_kind", "name": "Endpoint kind", "fn": lambda d: pool(d).get("endpoint_kind"), "icon": "mdi:api", "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "timeout_ms", "name": "Timeout", "fn": lambda d: _num(pool(d).get("timeout_ms")), "unit": "ms", "device_class": SensorDeviceClass.DURATION, "entity_category": EntityCategory.DIAGNOSTIC},
    ]


def _upstream_key_metrics(key: dict[str, Any]) -> list[dict[str, Any]]:
    key_id = key.get("id") or key.get("key_id")

    def spend_today(d: dict[str, Any]) -> Any:
        row = (d.get("budgeted_keys") or {}).get(key_id) or {}
        return _num(row.get("spend_today"))

    return [
        {"key": "circuit_state", "name": "Circuit state", "fn": lambda d: _current_key(d, key_id).get("circuit_state"), "icon": "mdi:circuit-chip", "device_class": SensorDeviceClass.ENUM, "options": ["CLOSED", "HALF_OPEN", "OPEN"]},
        {"key": "success_rate", "name": "Rolling success rate", "fn": lambda d: _num(_current_key(d, key_id).get("rolling_success_rate")), "unit": "%", "state_class": SensorStateClass.MEASUREMENT, "icon": "mdi:percent"},
        {"key": "latency_p50", "name": "Latency p50", "fn": lambda d: _num(_current_key(d, key_id).get("latency_p50")), "unit": "ms", "device_class": SensorDeviceClass.DURATION},
        {"key": "latency_p95", "name": "Latency p95", "fn": lambda d: _num(_current_key(d, key_id).get("latency_p95")), "unit": "ms", "device_class": SensorDeviceClass.DURATION},
        {"key": "current_rpm", "name": "Current RPM", "fn": lambda d: _num(_current_key(d, key_id).get("current_rpm")), "state_class": SensorStateClass.MEASUREMENT, "icon": "mdi:speedometer"},
        {"key": "rpm_cap", "name": "RPM cap", "fn": lambda d: _num(_current_key(d, key_id).get("rpm_cap")), "icon": "mdi:speedometer", "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "current_tpm", "name": "Current TPM", "fn": lambda d: _num(_current_key(d, key_id).get("current_tpm")), "state_class": SensorStateClass.MEASUREMENT, "icon": "mdi:speedometer"},
        {"key": "tpm_cap", "name": "TPM cap", "fn": lambda d: _num(_current_key(d, key_id).get("tpm_cap")), "icon": "mdi:speedometer", "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "spend_today", "name": "Spend today", "fn": spend_today, "unit": "USD", "device_class": SensorDeviceClass.MONETARY, "precision": 4},
        {"key": "daily_budget_cap", "name": "Daily budget cap", "fn": lambda d: _num(_current_key(d, key_id).get("daily_budget_cap")), "unit": "USD", "device_class": SensorDeviceClass.MONETARY, "entity_category": EntityCategory.DIAGNOSTIC, "precision": 4},
        {"key": "lifetime_spend", "name": "Lifetime spend", "fn": lambda d: _num(_current_key(d, key_id).get("daily_usage")), "unit": "USD", "device_class": SensorDeviceClass.MONETARY, "state_class": SensorStateClass.TOTAL_INCREASING, "precision": 4},
        {"key": "consecutive_failures", "name": "Consecutive failures", "fn": lambda d: _num(_current_key(d, key_id).get("consecutive_failures")), "state_class": SensorStateClass.MEASUREMENT, "icon": "mdi:alert"},
        {"key": "window_calls", "name": "Calls in window", "fn": lambda d: _num(_current_key(d, key_id).get("total_calls_window")), "state_class": SensorStateClass.MEASUREMENT, "icon": "mdi:counter", "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "masked_key", "name": "Masked key", "fn": lambda d: _current_key(d, key_id).get("masked_key"), "icon": "mdi:key-outline", "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "disabled_reason", "name": "Disabled reason", "fn": lambda d: _current_key(d, key_id).get("disabled_reason"), "icon": "mdi:information-outline", "entity_category": EntityCategory.DIAGNOSTIC},
    ]


def _current_key(data: dict[str, Any], key_id: str) -> dict[str, Any]:
    for key in data.get("keys") or []:
        if (key.get("id") or key.get("key_id")) == key_id:
            return key
    return {}


def _gateway_key_metrics(gk: dict[str, Any]) -> list[dict[str, Any]]:
    gk_id = gk.get("id")

    def current(d: dict[str, Any]) -> dict[str, Any]:
        for item in d.get("gateway_keys") or []:
            if item.get("id") == gk_id:
                return item
        return {}

    return [
        {"key": "rpm_limit", "name": "RPM limit", "fn": lambda d: _num(current(d).get("rpm_limit")), "icon": "mdi:speedometer", "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "tpm_limit", "name": "TPM limit", "fn": lambda d: _num(current(d).get("tpm_limit")), "icon": "mdi:speedometer", "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "allowed_aliases", "name": "Allowed pools", "fn": lambda d: float(len(current(d).get("allowed_aliases") or [])), "icon": "mdi:pool", "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "masked_token", "name": "Masked token", "fn": lambda d: current(d).get("masked_token"), "icon": "mdi:key-outline", "entity_category": EntityCategory.DIAGNOSTIC},
        {"key": "expires_at", "name": "Expires at", "fn": lambda d: _expires(current(d).get("expires_at")), "device_class": SensorDeviceClass.TIMESTAMP, "icon": "mdi:calendar-clock"},
    ]


def _expires(ms: Any) -> Any:
    if not ms:
        return None
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: KeyGateCoordinator = entry.runtime_data.coordinator
    added: set[str] = set()
    live: dict[str, SensorEntity] = {}

    def collect() -> tuple[list[SensorEntity], set[str] | None]:
        """Return new entities plus every unique suffix this platform still wants.

        ``None`` means "no fresh data", so the caller must not prune: a failed poll must never
        look like every pool/key was deleted.
        """
        if not coordinator.data:
            return [], None
        data = coordinator.data
        hub = hub_device(entry, coordinator.client.base_url)
        entities: list[SensorEntity] = []
        wanted: set[str] = set()

        def add(
            uid: str,
            name: str,
            fn: ValueFn,
            dev: DeviceInfo,
            **kwargs: Any,
        ) -> None:
            wanted.add(uid)
            if uid in added:
                return
            added.add(uid)
            entity = _KeyGateSensor(coordinator, uid, name, fn, dev, **kwargs)
            live[uid] = entity
            entities.append(entity)

        for spec in _global_specs():
            add(
                f"global_{spec['key']}",
                spec["name"],
                spec["fn"],
                hub,
                unit=spec.get("unit"),
                device_class=spec.get("device_class"),
                state_class=spec.get("state_class"),
                icon=spec.get("icon"),
                entity_category=spec.get("entity_category"),
                options=spec.get("options"),
                suggested_display_precision=spec.get("precision"),
            )

        for pool in data.get("pools") or []:
            alias = pool.get("alias_name")
            if not alias:
                continue
            dev = sub_device(hass, entry, "pool", str(alias), f"Pool {alias}")
            for spec in _pool_metrics(str(alias)):
                add(
                    f"pool_{alias}_{spec['key']}",
                    spec["name"],
                    spec["fn"],
                    dev,
                    unit=spec.get("unit"),
                    device_class=spec.get("device_class"),
                    state_class=spec.get("state_class"),
                    icon=spec.get("icon"),
                    entity_category=spec.get("entity_category"),
                    options=spec.get("options"),
                    suggested_display_precision=spec.get("precision"),
                )

        for key in data.get("keys") or []:
            key_id = key.get("id") or key.get("key_id")
            if not key_id:
                continue
            label = key.get("key_name") or str(key_id)
            dev = sub_device(hass, entry, "key", str(key_id), f"Key {label}")
            for spec in _upstream_key_metrics(key):
                add(
                    f"key_{key_id}_{spec['key']}",
                    spec["name"],
                    spec["fn"],
                    dev,
                    unit=spec.get("unit"),
                    device_class=spec.get("device_class"),
                    state_class=spec.get("state_class"),
                    icon=spec.get("icon"),
                    entity_category=spec.get("entity_category"),
                    options=spec.get("options"),
                    suggested_display_precision=spec.get("precision"),
                )

        for gk in data.get("gateway_keys") or []:
            gk_id = gk.get("id")
            if not gk_id:
                continue
            label = gk.get("name") or str(gk_id)
            dev = sub_device(hass, entry, "gateway_key", str(gk_id), f"Gateway key {label}")
            for spec in _gateway_key_metrics(gk):
                add(
                    f"gwkey_{gk_id}_{spec['key']}",
                    spec["name"],
                    spec["fn"],
                    dev,
                    unit=spec.get("unit"),
                    device_class=spec.get("device_class"),
                    state_class=spec.get("state_class"),
                    icon=spec.get("icon"),
                    entity_category=spec.get("entity_category"),
                    options=spec.get("options"),
                    suggested_display_precision=spec.get("precision"),
                )

        return entities, wanted

    def refresh() -> None:
        new_entities, wanted = collect()
        if new_entities:
            async_add_entities(new_entities)
        if wanted is None:
            return
        for suffix in async_prune_stale_entities(hass, entry, "sensor", wanted, live):
            added.discard(suffix)
            live.pop(suffix, None)

    refresh()
    entry.async_on_unload(coordinator.async_add_listener(refresh))
