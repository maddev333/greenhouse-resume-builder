"""Embedding generation for Azure OpenAI / OpenAI.com text embeddings.

Used by ``WikiAzureSearchBackend._embed`` to populate the ``bodyVector``
field in the wiki-sections index so that hybrid keyword + vector search
(the architecture plan's core retrieval mode) works end-to-end.

Configuration is via environment variables, same as Document Intelligence:

| Variable | Default | Notes |
|---|---|---|
| ``LLMWIKI_EMBEDDING_ENDPOINT`` | unset | Azure OpenAI endpoint e.g. ``https://<res>.openai.azure.com/openai/deployments/<dep>/embeddings?api-version=2024-02-01`` |
| ``LLMWIKI_EMBEDDING_API_KEY`` | unset | Key for the deployment, or omit to use Managed Identity / DefaultAzureCredential |
| ``LLMWIKI_EMBEDDING_DEPLOYMENT`` | ``text-embedding-3-small`` | Azure OpenAI deployment name to target |
| ``OPENAI_BASE_URL`` | unset | Alternative: use openai.com REST-compatible API |
| ``OPENAI_API_KEY`` | unset | Key for the above (also used by Azure DI) |

"""

from __future__ import annotations

import os
from typing import Any


# ---- Configuration helpers --------------------------------------------------

def _get_embedding_endpoint() -> str:
    """Return the OpenAI-compatible endpoint URL, or ``None``."""
    return os.environ.get("LLMWIKI_EMBEDDING_ENDPOINT") or os.environ.get(
        "OPENAI_BASE_URL", ""
    )


def _get_embedding_deployment() -> str:
    """Return the deployment name (defaults to text-embedding-3-small)."""
    return os.environ.get("LLMWIKI_OPENAI_EMBEDDING_DEPLOYMENT") or \
           os.environ.get("LLMWIKI_EMBEDDING_DEPLOYMENT") or "text-embedding-3-small"


def _get_embedding_api_key() -> str | None:
    """Return the API key, preferring LLMWiki-specific vars first."""
    return os.environ.get("LLMWIKI_EMBEDDING_API_KEY") or \
           os.environ.get("OPENAI_API_KEY")


# ---- Azure OpenAI path (preferred when endpoint has azure prefix) -----------

def _generate_via_azure(text: str) -> list[float] | None:
    """Generate embedding using Azure OpenAI REST API."""
    try:
        import httpx  # lightweight HTTP client (no heavy SDK dep)
    except ImportError:
        return None

    endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT") or \
               os.environ.get("LLMWIKI_EMBEDDING_ENDPOINT") or ""
    if not endpoint:
        return None

    deployment = _get_embedding_deployment()
    api_key = _get_embedding_api_key()
    if not api_key:
        # Try to get token via DefaultAzureCredential (Managed Identity)
        try:
            from azure.identity import DefaultAzureCredential
            cred = DefaultAzureCredential()
            token = cred.get_token("https://cognitiveservices.azure.com/.default")
            api_key = f"Bearer {token.token}"
        except ImportError:
            return None

    url = (endpoint.rstrip("/") + "/deployments/" + deployment + "/embeddings?api-version=2024-02-01")  # noqa: E501
    headers = {"Content-Type": "application/json"}
    if api_key.startswith("sk-"):
        headers["api-key"] = api_key  # Azure REST expects api-key header
    else:
        headers["Authorization"] = api_key

    payload = {
        "input": [text[:4096]],  # OpenAI truncates at 8192 tokens; safe guard
        "model": deployment,
    }

    resp = httpx.post(url, json=payload, headers=headers, timeout=30)
    if resp.status_code != 200:
        return None

    data = resp.json()
    embedding = data.get("data", [{}])[0].get("embedding")
    return embedding


# ---- OpenAI.com path --------------------------------------------------------

def _generate_via_openai(text: str) -> list[float] | None:
    """Generate embedding via openai.com REST API."""
    try:
        from openai import OpenAI as OpenAIClient
    except ImportError:
        # Try httpx
        try:
            import httpx
        except ImportError:
            return None

    api_key = _get_embedding_api_key()
    if not api_key:
        return None

    base_url = os.environ.get("OPENAI_BASE_URL")  # might include full url
    deployment = _get_embedding_deployment()

    client_kwargs = {"api_key": api_key}
    if base_url and "openai" in base_url:
        client_kwargs["base_url"] = base_url

    try:
        import httpx
        url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1") + \
              "/embeddings"
        resp = httpx.post(
            url,
            json={"input": [text[:4096]], "model": deployment},
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},  # noqa: E501
            timeout=30,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        return data["data"][0].get("embedding")
    except Exception:
        return None


# ---- Public API -------------------------------------------------------------

def generate_embedding(text: str) -> list[float] | None:
    """Generate a 1536-dim embedding vector for *text*.

    Tries Azure OpenAI first (via endpoint or DefaultAzureCredential),
    then falls back to openai.com REST API.  Returns ``None`` on any failure.
    """
    if not text:
        return None

    result = _generate_via_azure(text)
    if result is not None:
        return result

    return _generate_via_openai(text)


def batch_generate_texts(texts: list[str]) -> list[list[float] | None]:
    """Generate embeddings for a batch of texts (one call per text)."""
    return [generate_embedding(t) for t in texts]
