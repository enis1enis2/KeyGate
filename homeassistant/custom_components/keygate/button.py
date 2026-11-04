"""Buttons for KeyGate (circuit reset, toggles, revoke)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .coordinator import KeyGateCoordinator
from .entity import async_prune_stale_entities, hub_device, sub_device

ActionFn = Callable[[], Awaitable[Any]]


async def _noop() -> None:
    """Async no-op used by the refresh button."""


class KeyGateButton(CoordinatorEntity[KeyGateCoordinator], ButtonEntity):
    """A button that runs an action and refreshes the coordinator."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self,
        coordinator: KeyGateCoordinator,
        unique_suffix: str,
        name: str,
        action: ActionFn,
        device_info: DeviceInfo,
        *,
        icon: str | None = None,
        entity_category: EntityCategory | None = None,
    ) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{unique_suffix}"
        self._attr_name = name
        self._attr_icon = icon
        self._attr_entity_category = entity_category
        self._action = action
        self._device_info = device_info

    @property
    def device_info(self) -> DeviceInfo:
        return self._device_info

    async def async_press(self) -> None:
        await self._action()
        await self.coordinator.async_request_refresh()


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: KeyGateCoordinator = entry.runtime_data.coordinator
    client = entry.runtime_data.client
    added: set[str] = set()
    live: dict[str, ButtonEntity] = {}

    # Hub-level refresh button (static, so it is always wanted and never pruned).
    hub = hub_device(entry, client.base_url)
    refresh_button = KeyGateButton(
        coordinator, "refresh", "Refresh", _noop, hub, icon="mdi:refresh"
    )
    added.add("refresh")
    live["refresh"] = refresh_button
    async_add_entities([refresh_button])

    def collect() -> tuple[list[ButtonEntity], set[str] | None]:
        if not coordinator.data:
            return [], None
        data = coordinator.data
        entities: list[ButtonEntity] = []
        wanted: set[str] = {"refresh"}

        def add(
            uid: str,
            name: str,
            action: ActionFn,
            dev: DeviceInfo,
            **kwargs: Any,
        ) -> None:
            wanted.add(uid)
            if uid in added:
                return
            added.add(uid)
            entity = KeyGateButton(coordinator, uid, name, action, dev, **kwargs)
            live[uid] = entity
            entities.append(entity)

        for key in data.get("keys") or []:
            key_id = key.get("id") or key.get("key_id")
            if not key_id:
                continue
            label = key.get("key_name") or str(key_id)
            dev = sub_device(hass, entry, "key", str(key_id), f"Key {label}")
            add(
                f"key_{key_id}_reset",
                "Reset circuit",
                lambda i=key_id: client.async_reset_circuit(i),
                dev,
                icon="mdi:restart",
                entity_category=EntityCategory.CONFIG,
            )
            active = bool(key.get("is_active"))
            add(
                f"key_{key_id}_toggle",
                "Toggle active",
                lambda i=key_id, a=active: client.async_set_key_active(i, not a),
                dev,
                icon="mdi:power",
                entity_category=EntityCategory.CONFIG,
            )

        for gk in data.get("gateway_keys") or []:
            gk_id = gk.get("id")
            if not gk_id:
                continue
            label = gk.get("name") or str(gk_id)
            dev = sub_device(hass, entry, "gateway_key", str(gk_id), f"Gateway key {label}")
            add(
                f"gwkey_{gk_id}_revoke",
                "Revoke",
                lambda i=gk_id: client.async_revoke_gateway_key(i),
                dev,
                icon="mdi:key-remove",
                entity_category=EntityCategory.CONFIG,
            )

        return entities, wanted

    def refresh() -> None:
        new_entities, wanted = collect()
        if new_entities:
            async_add_entities(new_entities)
        if wanted is None:
            return
        for suffix in async_prune_stale_entities(hass, entry, "button", wanted, live):
            added.discard(suffix)
            live.pop(suffix, None)

    refresh()
    entry.async_on_unload(coordinator.async_add_listener(refresh))
