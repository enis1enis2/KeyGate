"""The KeyGate integration."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import device_registry as dr

from .api import (
    KeyGateApiError,
    KeyGateAuthError,
    KeyGateClient,
    KeyGateConnectionError,
    KeyGateError,
)
from .const import (
    CONF_ADMIN_TOKEN,
    CONF_GATEWAY_KEY,
    CONF_SCAN_INTERVAL,
    CONF_URL,
    CONF_VERIFY_SSL,
    DEFAULT_SCAN_INTERVAL,
    DOMAIN,
)
from .coordinator import KeyGateCoordinator
from .entity import hub_device

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.SENSOR, Platform.BINARY_SENSOR, Platform.BUTTON]

CONF_ENTRY_ID = "config_entry_id"


@dataclass
class KeyGateRuntimeData:
    """Runtime data stored on the config entry."""

    client: KeyGateClient
    coordinator: KeyGateCoordinator


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up KeyGate from a config entry."""
    merged = {**entry.data, **(entry.options or {})}
    verify_ssl = bool(merged.get(CONF_VERIFY_SSL, True))
    session = async_get_clientsession(hass, verify_ssl=verify_ssl)

    client = KeyGateClient(
        session,
        merged[CONF_URL],
        admin_token=merged.get(CONF_ADMIN_TOKEN),
        gateway_key=merged.get(CONF_GATEWAY_KEY) or None,
        verify_ssl=verify_ssl,
    )

    scan_interval = int(merged.get(CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL))
    coordinator = KeyGateCoordinator(hass, entry, client, scan_interval)
    await coordinator.async_config_entry_first_refresh()

    entry.runtime_data = KeyGateRuntimeData(client=client, coordinator=coordinator)

    # Register the hub device before the platforms load so sub-devices can use
    # via_device_id (via_device is deprecated and removed in HA 2027.8).
    dr.async_get(hass).async_get_or_create(
        config_entry_id=entry.entry_id,
        **hub_device(entry, merged[CONF_URL]),
    )

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a KeyGate config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        client: KeyGateClient = entry.runtime_data.client
        await client.async_close()
    return unloaded


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload when options change."""
    await hass.config_entries.async_reload(entry.entry_id)


# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------
def _resolve_client(hass: HomeAssistant, call: ServiceCall) -> KeyGateClient:
    entry_id = call.data.get(CONF_ENTRY_ID)
    if entry_id:
        entry = hass.config_entries.async_get_entry(entry_id)
    else:
        entries = hass.config_entries.async_entries(DOMAIN)
        entry = entries[0] if len(entries) == 1 else None
    if entry is None or getattr(entry, "runtime_data", None) is None:
        raise HomeAssistantError(
            "No loaded KeyGate entry found. Provide 'config_entry_id' when several are configured."
        )
    return entry.runtime_data.client


async def _call(coro) -> Any:
    try:
        return await coro
    except KeyGateAuthError as err:
        raise HomeAssistantError(f"KeyGate authentication failed: {err}") from err
    except KeyGateConnectionError as err:
        raise HomeAssistantError(f"Cannot reach KeyGate: {err}") from err
    except (KeyGateApiError, KeyGateError) as err:
        raise HomeAssistantError(str(err)) from err


def _schema(fields: dict) -> vol.Schema:
    with_entry = {vol.Optional(CONF_ENTRY_ID): str, **fields}
    return vol.Schema(with_entry)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register KeyGate services once."""
    if hass.services.has_service(DOMAIN, "chat_completion"):
        return True

    # --- data-plane: chat completion --------------------------------------
    async def _chat(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        messages = call.data.get("messages")
        if messages is None:
            text = call.data.get("message") or call.data.get("prompt")
            if not text:
                raise HomeAssistantError("Provide 'messages' or 'message'.")
            messages = [{"role": "user", "content": text}]
        payload: dict[str, Any] = {"model": call.data["model"], "messages": messages}
        for key in ("temperature", "top_p", "max_tokens", "tools", "tool_choice", "user"):
            if call.data.get(key) is not None:
                payload[key] = call.data[key]
        if call.data.get("extra"):
            payload.update(call.data["extra"])
        if call.data.get("stream"):
            payload["stream"] = True
        return await _call(client.async_chat_completion(payload))

    hass.services.async_register(
        DOMAIN,
        "chat_completion",
        _chat,
        schema=_schema(
            {
                vol.Required("model"): str,
                vol.Optional("messages"): object,
                vol.Optional("message"): str,
                vol.Optional("prompt"): str,
                vol.Optional("temperature"): vol.Coerce(float),
                vol.Optional("top_p"): vol.Coerce(float),
                vol.Optional("max_tokens"): vol.Coerce(int),
                vol.Optional("tools"): object,
                vol.Optional("tool_choice"): vol.Any(str, dict),
                vol.Optional("user"): str,
                vol.Optional("stream"): bool,
                vol.Optional("extra"): dict,
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )

    # --- data-plane: embeddings / models / passthrough --------------------
    async def _embeddings(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        payload = {k: v for k, v in call.data.items() if k != CONF_ENTRY_ID}
        return await _call(client.async_embeddings(payload))

    hass.services.async_register(
        DOMAIN,
        "embeddings",
        _embeddings,
        schema=_schema({vol.Required("model"): str, vol.Required("input"): vol.Any(str, list, dict)}),
        supports_response=SupportsResponse.ONLY,
    )

    async def _list_models(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(client.async_list_models())

    hass.services.async_register(
        DOMAIN, "list_models", _list_models, schema=_schema({}),
        supports_response=SupportsResponse.ONLY,
    )

    # --- upstream keys ----------------------------------------------------
    async def _create_key(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        payload = {k: v for k, v in call.data.items() if k != CONF_ENTRY_ID}
        return await _call(client.async_create_key(payload))

    hass.services.async_register(
        DOMAIN, "create_upstream_key", _create_key,
        schema=_schema(
            {
                vol.Required("provider_id"): str,
                vol.Required("key_name"): str,
                vol.Required("api_key"): str,
                vol.Optional("rpm_cap"): vol.Coerce(int),
                vol.Optional("tpm_cap"): vol.Coerce(int),
                vol.Optional("daily_budget_cap"): vol.Coerce(float),
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )

    async def _reset_circuit(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(client.async_reset_circuit(call.data["key_id"]))

    hass.services.async_register(
        DOMAIN, "reset_circuit", _reset_circuit,
        schema=_schema({vol.Required("key_id"): str}),
    )

    async def _set_key_active(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(
            client.async_set_key_active(call.data["key_id"], call.data["active"])
        )

    hass.services.async_register(
        DOMAIN, "set_upstream_key_active", _set_key_active,
        schema=_schema({vol.Required("key_id"): str, vol.Required("active"): bool}),
    )

    async def _set_key_caps(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(
            client.async_set_key_caps(
                call.data["key_id"],
                call.data.get("rpm_cap"),
                call.data.get("tpm_cap"),
                call.data.get("daily_budget_cap"),
            )
        )

    hass.services.async_register(
        DOMAIN, "set_upstream_key_caps", _set_key_caps,
        schema=_schema(
            {
                vol.Required("key_id"): str,
                vol.Optional("rpm_cap"): vol.Coerce(int),
                vol.Optional("tpm_cap"): vol.Coerce(int),
                vol.Optional("daily_budget_cap"): vol.Coerce(float),
            }
        ),
    )

    async def _delete_key(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(client.async_delete_key(call.data["key_id"]))

    hass.services.async_register(
        DOMAIN, "delete_upstream_key", _delete_key,
        schema=_schema({vol.Required("key_id"): str}),
    )

    # --- pools (model aliases) -------------------------------------------
    async def _upsert_pool(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        payload = {k: v for k, v in call.data.items() if k != CONF_ENTRY_ID}
        targets = payload.get("targets")
        if isinstance(targets, dict):
            targets = [targets]
        if targets is not None:
            payload["targets"] = [_coerce_target(t) for t in targets]
        return await _call(client.async_upsert_pool(payload))

    hass.services.async_register(
        DOMAIN, "upsert_pool", _upsert_pool,
        schema=_schema(
            {
                vol.Required("alias_name"): str,
                vol.Required("targets"): vol.Any(list, dict),
                vol.Optional("id"): str,
                vol.Optional("strategy"): str,
                vol.Optional("description"): str,
                vol.Optional("endpoint_kind"): str,
                vol.Optional("daily_token_cap"): vol.Coerce(int),
                vol.Optional("daily_spend_cap"): vol.Coerce(float),
                vol.Optional("hedging_enabled"): bool,
                vol.Optional("hedged_delay_ms"): vol.Coerce(int),
                vol.Optional("timeout_ms"): vol.Coerce(int),
                vol.Optional("is_active"): bool,
                vol.Optional("search_enabled"): bool,
                vol.Optional("search_provider"): str,
                vol.Optional("search_max_results"): vol.Coerce(int),
                vol.Optional("search_max_rounds"): vol.Coerce(int),
                vol.Optional("search_off_notice"): bool,
                vol.Optional("classifier_provider_id"): object,
                vol.Optional("classifier_model"): object,
                vol.Optional("tiers"): vol.Any(list, dict),
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )

    async def _delete_pool(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(client.async_delete_pool(call.data["pool_id"]))

    hass.services.async_register(
        DOMAIN, "delete_pool", _delete_pool,
        schema=_schema({vol.Required("pool_id"): str}),
    )

    # --- providers --------------------------------------------------------
    async def _upsert_provider(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(
            client.async_upsert_provider(
                call.data["spec_yaml"],
                name=call.data.get("name"),
                description=call.data.get("description"),
                preset=call.data.get("preset"),
                provider_id=call.data.get("provider_id"),
            )
        )

    hass.services.async_register(
        DOMAIN, "upsert_provider", _upsert_provider,
        schema=_schema(
            {
                vol.Required("spec_yaml"): str,
                vol.Optional("name"): str,
                vol.Optional("description"): str,
                vol.Optional("preset"): str,
                vol.Optional("provider_id"): str,
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )

    async def _delete_provider(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(client.async_delete_provider(call.data["provider_id"]))

    hass.services.async_register(
        DOMAIN, "delete_provider", _delete_provider,
        schema=_schema({vol.Required("provider_id"): str}),
    )

    async def _draft_provider(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(
            client.async_draft_provider_from_curl(
                call.data["curl_command"], call.data.get("sample_response")
            )
        )

    hass.services.async_register(
        DOMAIN, "draft_provider_from_curl", _draft_provider,
        schema=_schema(
            {
                vol.Required("curl_command"): str,
                vol.Optional("sample_response"): str,
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )

    async def _scan_provider(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(
            client.async_scan_provider(
                call.data["base_url"], call.data.get("preset", "openai"), call.data.get("api_key")
            )
        )

    hass.services.async_register(
        DOMAIN, "scan_provider", _scan_provider,
        schema=_schema(
            {
                vol.Required("base_url"): str,
                vol.Optional("preset"): str,
                vol.Optional("api_key"): str,
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )

    async def _test_provider(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(
            client.async_test_provider(
                call.data["spec_yaml"],
                call.data["test_key"],
                call.data.get("prompt"),
                call.data.get("model"),
            )
        )

    hass.services.async_register(
        DOMAIN, "test_provider", _test_provider,
        schema=_schema(
            {
                vol.Required("spec_yaml"): str,
                vol.Required("test_key"): str,
                vol.Optional("prompt"): str,
                vol.Optional("model"): str,
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )

    async def _quick_add(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        payload = {k: v for k, v in call.data.items() if k != CONF_ENTRY_ID}
        return await _call(client.async_quick_add_provider(payload))

    hass.services.async_register(
        DOMAIN, "quick_add_provider", _quick_add,
        schema=_schema(
            {
                vol.Required("name"): str,
                vol.Required("preset"): str,
                vol.Required("base_url"): str,
                vol.Required("model"): str,
                vol.Optional("api_key"): str,
                vol.Optional("description"): str,
                vol.Optional("pool_name"): str,
                vol.Optional("chat_path"): str,
                vol.Optional("preserveRoot"): bool,
                vol.Optional("timeout_ms"): vol.Coerce(int),
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )

    # --- pricing ----------------------------------------------------------
    async def _upsert_pricing(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        payload = {k: v for k, v in call.data.items() if k != CONF_ENTRY_ID}
        return await _call(client.async_upsert_pricing(payload))

    hass.services.async_register(
        DOMAIN, "upsert_pricing", _upsert_pricing,
        schema=_schema(
            {
                vol.Required("provider_id"): str,
                vol.Required("model"): str,
                vol.Required("input_per_mtok"): vol.Coerce(float),
                vol.Required("output_per_mtok"): vol.Coerce(float),
                vol.Optional("id"): str,
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )

    async def _delete_pricing(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(client.async_delete_pricing(call.data["pricing_id"]))

    hass.services.async_register(
        DOMAIN, "delete_pricing", _delete_pricing,
        schema=_schema({vol.Required("pricing_id"): str}),
    )

    # --- gateway keys -----------------------------------------------------
    async def _create_gateway_key(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        payload = {k: v for k, v in call.data.items() if k != CONF_ENTRY_ID}
        return await _call(client.async_create_gateway_key(payload))

    hass.services.async_register(
        DOMAIN, "create_gateway_key", _create_gateway_key,
        schema=_schema(
            {
                vol.Required("name"): str,
                vol.Optional("rpm_limit"): vol.Coerce(int),
                vol.Optional("tpm_limit"): vol.Coerce(int),
                vol.Optional("allowed_aliases"): vol.Any(list, dict),
                vol.Optional("expires_in_days"): vol.Coerce(int),
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )

    async def _revoke_gateway_key(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(client.async_revoke_gateway_key(call.data["key_id"]))

    hass.services.async_register(
        DOMAIN, "revoke_gateway_key", _revoke_gateway_key,
        schema=_schema({vol.Required("key_id"): str}),
    )

    async def _delete_gateway_key(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(client.async_delete_gateway_key(call.data["key_id"]))

    hass.services.async_register(
        DOMAIN, "delete_gateway_key", _delete_gateway_key,
        schema=_schema({vol.Required("key_id"): str}),
    )

    # --- logs / history ---------------------------------------------------
    async def _get_logs(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return {
            "logs": await _call(
                client.async_get_logs(
                    call.data.get("limit", 100),
                    call.data.get("status"),
                    call.data.get("provider_id"),
                    call.data.get("model"),
                    call.data.get("endpoint"),
                )
            )
        }

    hass.services.async_register(
        DOMAIN, "get_logs", _get_logs,
        schema=_schema(
            {
                vol.Optional("limit"): vol.Coerce(int),
                vol.Optional("status"): str,
                vol.Optional("provider_id"): str,
                vol.Optional("model"): str,
                vol.Optional("endpoint"): str,
            }
        ),
        supports_response=SupportsResponse.ONLY,
    )

    async def _get_history(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(
            client.async_get_history(call.data.get("pool"), call.data.get("limit", 100))
        )

    hass.services.async_register(
        DOMAIN, "get_history", _get_history,
        schema=_schema({vol.Optional("pool"): str, vol.Optional("limit"): vol.Coerce(int)}),
        supports_response=SupportsResponse.ONLY,
    )

    async def _get_history_pools(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return {"pools": await _call(client.async_get_history_pools())}

    hass.services.async_register(
        DOMAIN, "get_history_pools", _get_history_pools, schema=_schema({}),
        supports_response=SupportsResponse.ONLY,
    )

    async def _clear_history(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(client.async_clear_history(call.data.get("pool")))

    hass.services.async_register(
        DOMAIN, "clear_history", _clear_history,
        schema=_schema({vol.Optional("pool"): str}),
    )

    async def _delete_history_entry(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(client.async_delete_history_entry(call.data["entry_id"]))

    hass.services.async_register(
        DOMAIN, "delete_history_entry", _delete_history_entry,
        schema=_schema({vol.Required("entry_id"): str}),
    )

    async def _get_dashboard_stats(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(client.async_get_dashboard_stats())

    hass.services.async_register(
        DOMAIN, "get_dashboard_stats", _get_dashboard_stats, schema=_schema({}),
        supports_response=SupportsResponse.ONLY,
    )

    async def _get_health(call: ServiceCall) -> Any:
        client = _resolve_client(hass, call)
        return await _call(client.async_get_health())

    hass.services.async_register(
        DOMAIN, "get_health", _get_health, schema=_schema({}),
        supports_response=SupportsResponse.ONLY,
    )

    return True


def _coerce_target(target: Any) -> dict[str, Any]:
    """Normalise a pool target entry to the KeyGate TargetConfig shape."""
    if isinstance(target, str):
        return {"provider_id": target, "model": target, "weight": 100, "priority": 1}
    if isinstance(target, dict):
        return {
            "provider_id": target.get("provider_id"),
            "model": target.get("model"),
            "weight": int(target.get("weight", 100)),
            "priority": int(target.get("priority", 1)),
            **({"tier": target["tier"]} if target.get("tier") else {}),
        }
    raise HomeAssistantError(f"Invalid pool target: {target!r}")
