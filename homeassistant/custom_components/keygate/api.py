"""Async client for the KeyGate AI API gateway.

Covers both trust boundaries of KeyGate:
  * the management API under ``/api/*`` (+ ``/metrics``) authenticated with the
    ``KEYGATE_ADMIN_TOKEN`` bearer token, and
  * the OpenAI-compatible data plane under ``/v1/*`` authenticated with a
    ``kg-live-...`` gateway key, plus the unauthenticated ``/healthz`` probe.
"""

from __future__ import annotations

import asyncio
from typing import Any

import aiohttp

from .const import DEFAULT_TIMEOUT


class KeyGateError(Exception):
    """Base class for KeyGate client errors."""


class KeyGateAuthError(KeyGateError):
    """Raised when KeyGate rejects the provided credentials (HTTP 401/403)."""


class KeyGateConnectionError(KeyGateError):
    """Raised when KeyGate cannot be reached."""


class KeyGateApiError(KeyGateError):
    """Raised when KeyGate answers with an unexpected status code."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.message = message


def _extract_error(body: Any) -> str:
    """Best-effort human message from a KeyGate error envelope."""
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error.get("code") or error)
        if isinstance(error, str):
            return error
        if "message" in body:
            return str(body["message"])
    if isinstance(body, str):
        return body
    return "Unknown error"


class KeyGateClient:
    """Thin wrapper around the KeyGate HTTP API."""

    def __init__(
        self,
        session: aiohttp.ClientSession | None,
        base_url: str,
        admin_token: str | None = None,
        gateway_key: str | None = None,
        verify_ssl: bool = True,
    ) -> None:
        self._session = session
        self._owns_session = False
        self._base_url = base_url.rstrip("/")
        self._admin_token = admin_token
        self._gateway_key = gateway_key
        self._verify_ssl = verify_ssl

    # --- plumbing -------------------------------------------------------------
    @property
    def base_url(self) -> str:
        return self._base_url

    @property
    def has_gateway_key(self) -> bool:
        return bool(self._gateway_key)

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None:
            connector = aiohttp.TCPConnector(ssl=self._verify_ssl)
            self._session = aiohttp.ClientSession(connector=connector)
            self._owns_session = True
        return self._session

    async def async_close(self) -> None:
        if self._owns_session and self._session is not None:
            await self._session.close()
            self._session = None
            self._owns_session = False

    async def _request(
        self,
        method: str,
        path: str,
        *,
        admin: bool = False,
        gateway: bool = False,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        timeout: int = DEFAULT_TIMEOUT,
    ) -> Any:
        session = await self._get_session()
        url = f"{self._base_url}{path}"

        headers: dict[str, str] = {"Accept": "application/json"}
        if admin:
            if not self._admin_token:
                raise KeyGateAuthError("No admin token configured")
            headers["Authorization"] = f"Bearer {self._admin_token}"
        elif gateway:
            if not self._gateway_key:
                raise KeyGateAuthError("No gateway key configured")
            headers["Authorization"] = f"Bearer {self._gateway_key}"

        try:
            async with session.request(
                method,
                url,
                headers=headers,
                params=params,
                json=json_body,
                timeout=aiohttp.ClientTimeout(total=timeout),
            ) as resp:
                if resp.status in (401, 403):
                    raise KeyGateAuthError(
                        f"KeyGate rejected the credentials ({resp.status})"
                    )
                text = await resp.text()
                body: Any = _parse_body(resp, text)
                if resp.status >= 400:
                    raise KeyGateApiError(resp.status, _extract_error(body))
                return body
        except KeyGateError:
            raise
        except asyncio.TimeoutError as err:
            raise KeyGateConnectionError(f"Timed out talking to {url}") from err
        except aiohttp.ClientError as err:
            raise KeyGateConnectionError(str(err)) from err

    # --- health / metrics -----------------------------------------------------
    async def async_get_health(self) -> dict[str, Any]:
        return await self._request("GET", "/healthz")

    async def async_get_metrics(self) -> str:
        # Same guard as `_request(admin=True)`: without it a gateway-key-only entry sends the
        # literal header `Authorization: Bearer None`.
        if not self._admin_token:
            raise KeyGateAuthError("No admin token configured")
        session = await self._get_session()
        url = f"{self._base_url}/metrics"
        headers = {"Authorization": f"Bearer {self._admin_token}"}
        async with session.get(
            url, headers=headers, timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT)
        ) as resp:
            if resp.status in (401, 403):
                raise KeyGateAuthError("Invalid admin token")
            return await resp.text()

    # --- dashboard ------------------------------------------------------------
    async def async_get_dashboard_stats(self) -> dict[str, Any]:
        return await self._request("GET", "/api/dashboard/stats", admin=True)

    # --- providers ------------------------------------------------------------
    async def async_get_providers(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/providers", admin=True)

    async def async_get_provider(self, provider_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/api/providers/{provider_id}", admin=True)

    async def async_get_provider_presets(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/providers/presets", admin=True)

    async def async_upsert_provider(
        self,
        spec_yaml: str,
        name: str | None = None,
        description: str | None = None,
        preset: str | None = None,
        provider_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"spec_yaml": spec_yaml}
        if name is not None:
            payload["name"] = name
        if description is not None:
            payload["description"] = description
        if preset is not None:
            payload["preset"] = preset
        if provider_id is not None:
            payload["id"] = provider_id
        return await self._request("POST", "/api/providers", admin=True, json_body=payload)

    async def async_delete_provider(self, provider_id: str) -> dict[str, Any]:
        return await self._request("DELETE", f"/api/providers/{provider_id}", admin=True)

    async def async_draft_provider_from_curl(
        self, curl_command: str, sample_response: str | None = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"curl_command": curl_command}
        if sample_response is not None:
            payload["sample_response"] = sample_response
        return await self._request(
            "POST", "/api/providers/wizard/draft", admin=True, json_body=payload, timeout=60
        )

    async def async_scan_provider(
        self, base_url: str, preset: str = "openai", api_key: str | None = None
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"preset": preset, "base_url": base_url}
        if api_key:
            payload["api_key"] = api_key
        return await self._request(
            "POST", "/api/providers/scan", admin=True, json_body=payload, timeout=60
        )

    async def async_test_provider(
        self,
        spec_yaml: str,
        test_key: str,
        prompt: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"spec_yaml": spec_yaml, "test_key": test_key}
        if prompt is not None:
            payload["prompt"] = prompt
        if model is not None:
            payload["model"] = model
        return await self._request(
            "POST", "/api/providers/test", admin=True, json_body=payload, timeout=60
        )

    async def async_quick_add_provider(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request(
            "POST", "/api/providers/quick-add", admin=True, json_body=payload, timeout=60
        )

    # --- upstream keys --------------------------------------------------------
    async def async_get_keys(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/keys", admin=True)

    async def async_create_key(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/api/keys", admin=True, json_body=payload)

    async def async_update_key(self, key_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request(
            "PUT", f"/api/keys/{key_id}", admin=True, json_body=payload
        )

    async def async_delete_key(self, key_id: str) -> dict[str, Any]:
        return await self._request("DELETE", f"/api/keys/{key_id}", admin=True)

    async def async_reset_circuit(self, key_id: str) -> dict[str, Any]:
        return await self.async_update_key(key_id, {"reset_circuit": True})

    async def async_set_key_active(self, key_id: str, active: bool) -> dict[str, Any]:
        return await self.async_update_key(key_id, {"is_active": active})

    async def async_set_key_caps(
        self,
        key_id: str,
        rpm_cap: int | None = None,
        tpm_cap: int | None = None,
        daily_budget_cap: float | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {}
        if rpm_cap is not None:
            payload["rpm_cap"] = rpm_cap
        if tpm_cap is not None:
            payload["tpm_cap"] = tpm_cap
        if daily_budget_cap is not None:
            payload["daily_budget_cap"] = daily_budget_cap
        return await self.async_update_key(key_id, payload)

    # --- pools (model aliases) ------------------------------------------------
    async def async_get_pools(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/aliases", admin=True)

    async def async_upsert_pool(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/api/aliases", admin=True, json_body=payload)

    async def async_delete_pool(self, pool_id: str) -> dict[str, Any]:
        return await self._request("DELETE", f"/api/aliases/{pool_id}", admin=True)

    # --- pricing --------------------------------------------------------------
    async def async_get_pricing(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/pricing", admin=True)

    async def async_upsert_pricing(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/api/pricing", admin=True, json_body=payload)

    async def async_delete_pricing(self, pricing_id: str) -> dict[str, Any]:
        return await self._request("DELETE", f"/api/pricing/{pricing_id}", admin=True)

    # --- gateway keys ---------------------------------------------------------
    async def async_get_gateway_keys(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/gateway-keys", admin=True)

    async def async_create_gateway_key(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._request(
            "POST", "/api/gateway-keys", admin=True, json_body=payload
        )

    async def async_revoke_gateway_key(self, key_id: str) -> dict[str, Any]:
        return await self._request(
            "POST", f"/api/gateway-keys/{key_id}/revoke", admin=True
        )

    async def async_delete_gateway_key(self, key_id: str) -> dict[str, Any]:
        return await self._request("DELETE", f"/api/gateway-keys/{key_id}", admin=True)

    # --- logs / history -------------------------------------------------------
    async def async_get_logs(
        self,
        limit: int = 100,
        status: str | None = None,
        provider_id: str | None = None,
        model: str | None = None,
        endpoint: str | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if status:
            params["status"] = status
        if provider_id:
            params["provider_id"] = provider_id
        if model:
            params["model"] = model
        if endpoint:
            params["endpoint"] = endpoint
        return await self._request("GET", "/api/logs", admin=True, params=params)

    async def async_get_history(
        self, pool: str | None = None, limit: int = 100
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": limit}
        if pool:
            params["pool"] = pool
        return await self._request("GET", "/api/history", admin=True, params=params)

    async def async_get_history_pools(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/history/pools", admin=True)

    async def async_delete_history_entry(self, entry_id: str) -> dict[str, Any]:
        return await self._request("DELETE", f"/api/history/{entry_id}", admin=True)

    async def async_clear_history(self, pool: str | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if pool:
            params["pool"] = pool
        return await self._request("DELETE", "/api/history", admin=True, params=params)

    # --- /v1 data plane -------------------------------------------------------
    async def async_list_models(self) -> dict[str, Any]:
        return await self._request("GET", "/v1/models", gateway=True)

    async def async_chat_completion(
        self, payload: dict[str, Any], timeout: int = 120
    ) -> dict[str, Any]:
        return await self._request(
            "POST", "/v1/chat/completions", gateway=True, json_body=payload, timeout=timeout
        )

    async def async_embeddings(
        self, payload: dict[str, Any], timeout: int = 120
    ) -> dict[str, Any]:
        return await self._request(
            "POST", "/v1/embeddings", gateway=True, json_body=payload, timeout=timeout
        )

    async def async_passthrough(
        self, provider: str, endpoint: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        path = f"/v1/passthrough/{provider}/{endpoint.lstrip('/')}"
        return await self._request("POST", path, gateway=True, json_body=payload or {})


def _parse_body(resp: aiohttp.ClientResponse, text: str) -> Any:
    """Parse a response body as JSON when possible."""
    if not text:
        return None
    content_type = resp.headers.get("Content-Type", "")
    if "application/json" in content_type or text.startswith(("{", "[")):
        import json

        try:
            return json.loads(text)
        except ValueError:
            return text
    return text
