"""Binary sensors for KeyGate."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .coordinator import KeyGateCoordinator
from .entity import async_prune_stale_entities, hub_device, sub_device

BoolFn = Callable[[dict[str, Any]], bool | None]


class KeyGateBinarySensor(CoordinatorEntity[KeyGateCoordinator], BinarySensorEntity):
    """Generic boolean entity driven by a value function."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self,
        coordinator: KeyGateCoordinator,
        unique_suffix: str,
        name: str,
        is_on_fn: BoolFn,
        device_info: DeviceInfo,
        *,
        device_class: BinarySensorDeviceClass | None = None,
        icon: str | None = None,
        entity_category: EntityCategory | None = None,
    ) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{unique_suffix}"
        self._attr_name = name
        self._attr_device_class = device_class
        self._attr_icon = icon
        self._attr_entity_category = entity_category
        self._is_on = is_on_fn
        self._device_info = device_info

    @property
    def device_info(self) -> DeviceInfo:
        return self._device_info

    @property
    def is_on(self) -> bool | None:
        if not self.coordinator.data:
            return None
        return self._is_on(self.coordinator.data)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: KeyGateCoordinator = entry.runtime_data.coordinator
    added: set[str] = set()
    live: dict[str, BinarySensorEntity] = {}

    def collect() -> tuple[list[BinarySensorEntity], set[str] | None]:
        if not coordinator.data:
            return [], None
        data = coordinator.data
        hub = hub_device(entry, coordinator.client.base_url)
        entities: list[BinarySensorEntity] = []
        wanted: set[str] = set()

        def add(uid: str, name: str, fn: BoolFn, dev: DeviceInfo, **kwargs: Any) -> None:
            wanted.add(uid)
            if uid in added:
                return
            added.add(uid)
            entity = KeyGateBinarySensor(coordinator, uid, name, fn, dev, **kwargs)
            live[uid] = entity
            entities.append(entity)

        add(
            "online",
            "Online",
            lambda d: d["health"].get("status") == "healthy",
            hub,
            device_class=BinarySensorDeviceClass.CONNECTIVITY,
        )
        add(
            "db_ok",
            "Database healthy",
            lambda d: str(d["health"].get("database", "")).startswith("ok"),
            hub,
            icon="mdi:database-check",
            entity_category=EntityCategory.DIAGNOSTIC,
        )

        for pool in data.get("pools") or []:
            alias = pool.get("alias_name")
            if not alias:
                continue
            dev = sub_device(hass, entry, "pool", str(alias), f"Pool {alias}")
            add(
                f"pool_{alias}_active",
                "Active",
                lambda d, a=alias: _pool(d, a).get("is_active"),
                dev,
                icon="mdi:power",
            )
            add(
                f"pool_{alias}_over_budget",
                "Over budget",
                lambda d, a=alias: _pool_over_budget(d, a),
                dev,
                device_class=BinarySensorDeviceClass.PROBLEM,
            )

        for key in data.get("keys") or []:
            key_id = key.get("id") or key.get("key_id")
            if not key_id:
                continue
            label = key.get("key_name") or str(key_id)
            dev = sub_device(hass, entry, "key", str(key_id), f"Key {label}")
            add(
                f"key_{key_id}_active",
                "Active",
                lambda d, i=key_id: bool(_key(d, i).get("is_active")),
                dev,
                icon="mdi:power",
            )
            add(
                f"key_{key_id}_circuit_open",
                "Circuit open",
                lambda d, i=key_id: _key(d, i).get("circuit_state") == "OPEN",
                dev,
                device_class=BinarySensorDeviceClass.PROBLEM,
            )
            add(
                f"key_{key_id}_disabled",
                "Disabled",
                lambda d, i=key_id: not bool(_key(d, i).get("is_active")),
                dev,
                device_class=BinarySensorDeviceClass.PROBLEM,
                entity_category=EntityCategory.DIAGNOSTIC,
            )

        for gk in data.get("gateway_keys") or []:
            gk_id = gk.get("id")
            if not gk_id:
                continue
            label = gk.get("name") or str(gk_id)
            dev = sub_device(hass, entry, "gateway_key", str(gk_id), f"Gateway key {label}")
            add(
                f"gwkey_{gk_id}_active",
                "Active",
                lambda d, i=gk_id: bool(_gwkey(d, i).get("is_active")),
                dev,
                icon="mdi:power",
            )
            add(
                f"gwkey_{gk_id}_expired",
                "Expired",
                lambda d, i=gk_id: _gwkey_expired(d, i),
                dev,
                device_class=BinarySensorDeviceClass.PROBLEM,
            )

        for provider in data.get("providers") or []:
            pid = provider.get("id")
            if not pid:
                continue
            label = provider.get("name") or str(pid)
            dev = sub_device(hass, entry, "provider", str(pid), f"Provider {label}")
            add(
                f"provider_{pid}_active",
                "Active",
                lambda d, i=pid: bool(_provider(d, i).get("is_active")),
                dev,
                icon="mdi:power",
            )

        return entities, wanted

    def refresh() -> None:
        new_entities, wanted = collect()
        if new_entities:
            async_add_entities(new_entities)
        if wanted is None:
            return
        for suffix in async_prune_stale_entities(hass, entry, "binary_sensor", wanted, live):
            added.discard(suffix)
            live.pop(suffix, None)

    refresh()
    entry.async_on_unload(coordinator.async_add_listener(refresh))


def _pool(data: dict[str, Any], alias: str) -> dict[str, Any]:
    for pool in data.get("pools") or []:
        if pool.get("alias_name") == alias:
            return pool
    return {}


def _pool_over_budget(data: dict[str, Any], alias: str) -> bool:
    pool = _pool(data, alias)
    usage = (data.get("pool_usage") or {}).get(alias) or {}
    token_cap = pool.get("daily_token_cap") or 0
    spend_cap = pool.get("daily_spend_cap") or 0
    if token_cap and (usage.get("tokens") or 0) >= token_cap:
        return True
    return bool(spend_cap and (usage.get("spend") or 0) >= spend_cap)


def _key(data: dict[str, Any], key_id: str) -> dict[str, Any]:
    for key in data.get("keys") or []:
        if (key.get("id") or key.get("key_id")) == key_id:
            return key
    return {}


def _gwkey(data: dict[str, Any], gk_id: str) -> dict[str, Any]:
    for item in data.get("gateway_keys") or []:
        if item.get("id") == gk_id:
            return item
    return {}


def _gwkey_expired(data: dict[str, Any], gk_id: str) -> bool:
    from time import time

    expires = _gwkey(data, gk_id).get("expires_at")
    return bool(expires and time() * 1000 > expires)


def _provider(data: dict[str, Any], pid: str) -> dict[str, Any]:
    for provider in data.get("providers") or []:
        if provider.get("id") == pid:
            return provider
    return {}
