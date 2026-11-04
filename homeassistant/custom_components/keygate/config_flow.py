"""Config flow for the KeyGate integration."""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.config_entries import ConfigEntry, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import KeyGateApiError, KeyGateAuthError, KeyGateClient, KeyGateConnectionError
from .const import (
    CONF_ADMIN_TOKEN,
    CONF_GATEWAY_KEY,
    CONF_SCAN_INTERVAL,
    CONF_URL,
    CONF_VERIFY_SSL,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
    MIN_SCAN_INTERVAL,
)

_LOGGER = logging.getLogger(__name__)

STEP_USER_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_URL): str,
        vol.Required(CONF_ADMIN_TOKEN): str,
        vol.Optional(CONF_GATEWAY_KEY, default=""): str,
        vol.Optional(CONF_VERIFY_SSL, default=True): bool,
        vol.Optional(CONF_SCAN_INTERVAL, default=DEFAULT_SCAN_INTERVAL): vol.All(
            vol.Coerce(int), vol.Range(min=MIN_SCAN_INTERVAL)
        ),
    }
)


def _normalize_url(url: str) -> str:
    return url.strip().rstrip("/")


async def _validate(hass, data: dict[str, Any]) -> None:
    """Validate credentials and reachability. Raises on failure."""
    session = async_get_clientsession(hass, verify_ssl=bool(data.get(CONF_VERIFY_SSL, True)))
    client = KeyGateClient(
        session,
        _normalize_url(data[CONF_URL]),
        admin_token=data[CONF_ADMIN_TOKEN],
        gateway_key=data.get(CONF_GATEWAY_KEY) or None,
        verify_ssl=bool(data.get(CONF_VERIFY_SSL, True)),
    )
    await client.async_get_health()
    await client.async_get_dashboard_stats()


class KeyGateConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for KeyGate."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            user_input[CONF_URL] = _normalize_url(user_input[CONF_URL])
            await self.async_set_unique_id(user_input[CONF_URL].lower())
            self._abort_if_unique_id_configured()

            try:
                await _validate(self.hass, user_input)
            except KeyGateAuthError:
                errors["base"] = "invalid_auth"
            except KeyGateConnectionError:
                errors["base"] = "cannot_connect"
            except KeyGateApiError as err:
                _LOGGER.debug("KeyGate API error during setup: %s", err)
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Unexpected error validating KeyGate")
                errors["base"] = "unknown"
            else:
                return self.async_create_entry(
                    title=f"KeyGate ({user_input[CONF_URL]})",
                    data=user_input,
                )

        return self.async_show_form(
            step_id="user", data_schema=STEP_USER_SCHEMA, errors=errors
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        entry = self._get_reconfigure_entry()

        if user_input is not None:
            user_input[CONF_URL] = _normalize_url(user_input[CONF_URL])
            try:
                await _validate(self.hass, user_input)
            except KeyGateAuthError:
                errors["base"] = "invalid_auth"
            except KeyGateConnectionError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Unexpected error reconfiguring KeyGate")
                errors["base"] = "unknown"
            else:
                return self.async_update_reload_and_abort(
                    entry,
                    data=user_input,
                )

        schema = self.add_suggested_values_to_schema(
            STEP_USER_SCHEMA, entry.data
        )
        return self.async_show_form(
            step_id="reconfigure", data_schema=schema, errors=errors
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return KeyGateOptionsFlow()


class KeyGateOptionsFlow(OptionsFlow):
    """Options for KeyGate (polling interval, gateway key)."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        entry = self.config_entry
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        options = entry.options
        current = {
            CONF_SCAN_INTERVAL: options.get(
                CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL
            ),
            CONF_GATEWAY_KEY: options.get(
                CONF_GATEWAY_KEY, entry.data.get(CONF_GATEWAY_KEY, "")
            ),
        }
        schema = vol.Schema(
            {
                vol.Optional(
                    CONF_SCAN_INTERVAL, default=current[CONF_SCAN_INTERVAL]
                ): vol.All(vol.Coerce(int), vol.Range(min=MIN_SCAN_INTERVAL, max=3600)),
                vol.Optional(
                    CONF_GATEWAY_KEY, default=current[CONF_GATEWAY_KEY]
                ): str,
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema, errors=errors)
