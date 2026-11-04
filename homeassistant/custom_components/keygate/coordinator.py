"""DataUpdateCoordinator for KeyGate."""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import KeyGateAuthError, KeyGateClient, KeyGateConnectionError, KeyGateError
from .const import DEFAULT_SCAN_INTERVAL, DOMAIN

_LOGGER = logging.getLogger(__name__)


class KeyGateCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Polls the KeyGate management API and merges the results."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        client: KeyGateClient,
        scan_interval: int = DEFAULT_SCAN_INTERVAL,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=f"{DOMAIN} ({entry.title})",
            update_interval=timedelta(seconds=scan_interval),
        )
        self.client = client
        self.entry = entry

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            health, stats, providers, keys, pools, gateway_keys = await asyncio.gather(
                self.client.async_get_health(),
                self.client.async_get_dashboard_stats(),
                self.client.async_get_providers(),
                self.client.async_get_keys(),
                self.client.async_get_pools(),
                self.client.async_get_gateway_keys(),
            )
        except KeyGateAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except KeyGateConnectionError as err:
            raise UpdateFailed(f"Cannot reach KeyGate: {err}") from err
        except KeyGateError as err:
            raise UpdateFailed(str(err)) from err

        pool_usage = {
            row.get("pool"): row for row in (stats.get("poolUsageToday") or [])
        }

        return {
            "health": health or {},
            "stats": stats or {},
            "providers": providers or [],
            "keys": keys or [],
            "pools": pools or [],
            "gateway_keys": gateway_keys or [],
            "pool_usage": pool_usage,
            "budgeted_keys": {
                row.get("id"): row for row in (stats.get("budgetedKeys") or [])
            },
        }
