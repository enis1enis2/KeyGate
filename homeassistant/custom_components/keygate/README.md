# KeyGate — Home Assistant integration

A fully-covering custom integration for the [KeyGate](https://github.com/enis1enis2/KeyGate)
self-hosted AI API gateway. It polls the KeyGate **management API** (`/api/*`) and exposes the
gateway as Home Assistant devices, entities and services, and it can drive the
OpenAI-compatible data plane (`/v1/*`) through a gateway key.

## Features

- **Config flow** (UI setup, reconfigure, options) for base URL, admin token, optional gateway
  key, SSL verification and polling interval.
- **Devices**: one hub device plus per-pool, per-upstream-key, per-gateway-key and per-provider
  sub-devices (auto-discovered as you add them in KeyGate).
- **Sensors**: gateway-wide KPIs (requests, success/error, success rate, p50/p95 latency, tokens,
  spend today, key/provider/pool counts, circuit counts, uptime, health), per-pool usage & budget
  utilisation, per upstream key health (circuit state, success rate, latency, rpm/tpm, spend), and
  per gateway key limits/expiry.
- **Binary sensors**: online, database health, pool active/over-budget, key active/circuit-open/
  disabled, gateway key active/expired, provider active.
- **Buttons**: refresh, reset circuit, enable/disable upstream key, revoke gateway key.
- **Services**: the full management surface — pools, providers (spec YAML, quick-add, cURL draft,
  scan, live test), upstream keys, gateway keys, pricing, logs and chat history — plus
  `keygate.chat_completion`, `keygate.embeddings` and `keygate.list_models` for the data plane.
- **Diagnostics** with secrets redacted.

## Installation

Copy `custom_components/keygate` into your Home Assistant `config/` directory and restart:

```bash
cp -r custom_components/keygate <config>/custom_components/keygate
```

Then **Settings → Devices & Services → Add Integration → KeyGate** and fill in:

| Field | Description |
| --- | --- |
| Base URL | Where KeyGate is reachable, e.g. `http://192.168.1.50:3000` |
| Admin token | Your `KEYGATE_ADMIN_TOKEN` (management API) |
| Gateway key | Optional `kg-live-...` token (enables chat/embeddings/models services) |
| Verify SSL | Disable for self-signed HTTPS |
| Scan interval | Polling interval in seconds (default 30) |

## Services

All services accept an optional `config_entry_id` to target a specific KeyGate instance when
several are configured.

| Service | Purpose |
| --- | --- |
| `keygate.chat_completion` | Chat completion through a pool (returns the response) |
| `keygate.embeddings` | Embeddings through a pool |
| `keygate.list_models` | List pools visible to the gateway key |
| `keygate.create_upstream_key` / `delete_upstream_key` | Manage encrypted upstream keys |
| `keygate.reset_circuit` / `set_upstream_key_active` / `set_upstream_key_caps` | Key health control |
| `keygate.upsert_pool` / `delete_pool` | Manage AI pools |
| `keygate.upsert_provider` / `delete_provider` | Save declarative provider specs |
| `keygate.draft_provider_from_curl` / `scan_provider` / `test_provider` / `quick_add_provider` | Provider onboarding |
| `keygate.create_gateway_key` / `revoke_gateway_key` / `delete_gateway_key` | Client token management |
| `keygate.upsert_pricing` / `delete_pricing` | Cost metering rows |
| `keygate.get_logs` / `get_history` / `get_history_pools` / `clear_history` / `delete_history_entry` | Observability |
| `keygate.get_dashboard_stats` / `get_health` | Raw API snapshots |

### Example automation

```yaml
automation:
  - alias: KeyGate daily summary
    trigger:
      - platform: time
        at: "20:00:00"
    action:
      - service: keygate.get_dashboard_stats
        response_variable: stats
      - service: notify.mobile_app
        data:
          message: >-
            KeyGate today: {{ stats.spendToday | round(4) }} USD,
            {{ stats.totalRequests }} requests,
            {{ stats.successRate }}% success.
```

```yaml
# Ask a pool from an automation and use the answer
- service: keygate.chat_completion
  data:
    model: gpt-4o
    message: "Summarise the house status in one sentence."
  response_variable: reply
- service: persistent_notification.create
  data:
    title: KeyGate
    message: "{{ reply.choices[0].message.content }}"
```

## Notes

- Upstream API keys are never returned in full by KeyGate; only masked prefixes are surfaced.
- Entities are created dynamically, so new pools/keys/providers appear without reloading the
  integration (a reload also re-syncs them).
