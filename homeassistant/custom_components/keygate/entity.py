"""Shared device and entity-registry helpers for KeyGate."""

from __future__ import annotations

import logging
from collections.abc import Mapping

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN, MANUFACTURER, MODEL

_LOGGER = logging.getLogger(__name__)


def hub_device(entry: ConfigEntry, url: str) -> DeviceInfo:
    """Return the DeviceInfo for the KeyGate hub."""
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name=entry.title,
        manufacturer=MANUFACTURER,
        model=MODEL,
        configuration_url=url,
    )


def sub_device(
    hass: HomeAssistant, entry: ConfigEntry, kind: str, item_id: str, name: str
) -> DeviceInfo:
    """Return the DeviceInfo for a pool/key/provider sub-device.

    ``via_device`` (a tuple identifier) is deprecated in favour of
    ``via_device_id``, so resolve the hub device's registry id. The hub is
    created eagerly in ``async_setup_entry`` before the platforms load, which
    guarantees it is present here.
    """
    info = DeviceInfo(
        identifiers={(DOMAIN, f"{entry.entry_id}_{kind}_{item_id}")},
        name=name,
        manufacturer=MANUFACTURER,
        model=kind.replace("_", " ").title(),
    )
    hub = dr.async_get(hass).async_get_device_by_identifier(
        (DOMAIN, entry.entry_id), entry.entry_id
    )
    if hub is not None:
        info["via_device_id"] = hub.id
    return info


@callback
def async_prune_stale_entities(
    hass: HomeAssistant,
    entry: ConfigEntry,
    domain: str,
    wanted: set[str],
    live_entities: Mapping[str, Entity] | None = None,
) -> set[str]:
    """Drop registry entries this platform no longer generates.

    Entities for pools, upstream keys, gateway keys and providers are created
    from polled data, so one deleted or renamed in KeyGate would otherwise leave
    its entities behind forever (including entities from before a restart).

    Returns the unique-id suffixes that were removed so the caller can forget
    them and recreate the entity if the item comes back.
    """
    registry = er.async_get(hass)
    prefix = f"{entry.entry_id}_"
    removed: set[str] = set()

    for reg_entry in er.async_entries_for_config_entry(registry, entry.entry_id):
        if reg_entry.domain != domain:
            continue
        unique_id = reg_entry.unique_id
        if not unique_id or not unique_id.startswith(prefix):
            continue
        suffix = unique_id.removeprefix(prefix)
        if suffix in wanted:
            continue

        _LOGGER.debug("Removing stale %s entity %s", domain, reg_entry.entity_id)
        entity = (live_entities or {}).get(suffix)
        if entity is not None:
            # The platform still owns a live object for this unique ID; removing it through
            # Entity.async_remove() also detaches it from the platform, so a coordinator
            # update cannot resurrect the state after the registry entry is gone.
            hass.async_create_task(entity.async_remove(force_remove=True))
        else:
            registry.async_remove(reg_entry.entity_id)
            hass.states.async_remove(reg_entry.entity_id)
        removed.add(suffix)

    return removed
