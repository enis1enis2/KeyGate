"""Constants for the KeyGate integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "keygate"

# --- Configuration keys -------------------------------------------------------
CONF_URL: Final = "url"
CONF_ADMIN_TOKEN: Final = "admin_token"
CONF_GATEWAY_KEY: Final = "gateway_key"
CONF_VERIFY_SSL: Final = "verify_ssl"
CONF_SCAN_INTERVAL: Final = "scan_interval"

DEFAULT_SCAN_INTERVAL: Final = 30
MIN_SCAN_INTERVAL: Final = 5
MAX_SCAN_INTERVAL: Final = 3600
DEFAULT_TIMEOUT: Final = 20

MANUFACTURER: Final = "KeyGate"
MODEL: Final = "AI API Gateway"

# --- Circuit breaker states (mirrors src/types/index.ts CircuitState) ----------
CIRCUIT_CLOSED: Final = "CLOSED"
CIRCUIT_HALF_OPEN: Final = "HALF_OPEN"
CIRCUIT_OPEN: Final = "OPEN"
CIRCUIT_STATES: Final = [CIRCUIT_CLOSED, CIRCUIT_HALF_OPEN, CIRCUIT_OPEN]

ROUTING_STRATEGIES: Final = [
    "weighted-by-health",
    "round-robin",
    "priority",
    "by-ai",
]

# Mirrors ENDPOINT_KINDS in backend/src/routes/aliases.ts. Anything else is
# silently coerced to "chat" by the backend, so it must not be offered.
ENDPOINT_KINDS: Final = [
    "chat",
    "responses",
    "completions",
    "embeddings",
    "images",
    "audio",
    "moderations",
    "batches",
]

SEARCH_PROVIDERS: Final = ["duckduckgo", "wikipedia"]

# Mirrors PROVIDER_PRESETS in backend/src/engine/quick-add.ts. An unknown preset
# is silently treated as "openai" by the backend, so this list must stay exact.
PROVIDER_PRESETS: Final = [
    "openai",
    "claude",
    "gemini",
    "groq",
    "mistral",
    "deepseek",
    "openrouter",
    "xai",
    "perplexity",
    "together",
    "aion",
    "zai",
    "cohere",
    "nvidia",
    "siliconflow",
    "modelscope",
    "huggingface",
    "cloudflare",
    "ollama-cloud",
    "kilocode",
    "llm7",
    "ovhcloud",
    "ollama",
    "lmstudio",
    "llamacpp",
    "localai",
    "vllm",
]
