#!/usr/bin/env python3
"""ROXY launcher. Usage: python run.py [--host 0.0.0.0] [--port 8000] [--reload]"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the ROXY assistant server.")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    try:
        import uvicorn  # noqa: WPS433
    except ImportError:
        print("ERROR: uvicorn is not installed. Run: pip install -r backend/requirements.txt")
        return 1

    from backend.config import get_settings

    settings = get_settings()
    host = args.host or settings.host
    port = args.port or settings.port

    env_file = ROOT / "backend" / ".env"
    if not env_file.exists():
        print("NOTE: backend/.env not found. Copy backend/.env.example -> backend/.env")
        print("      ROXY will start in OFFLINE DEMO mode (mock provider) until a key is set.\n")
    elif Path(str(env_file) + ".txt").exists():
        print("NOTE: backend/.env exists, and backend/.env.txt also exists. Use the file named exactly '.env'.")

    active = settings.active_provider_config()
    gemini_cfg = settings.provider_config("gemini")
    print(f"  ROXY online at http://{host if host != '0.0.0.0' else 'localhost'}:{port}")
    print(f"  provider={settings.provider}  active={active.name}  model={active.model or '(default)'}")
    print(f"  env={env_file}")
    print(f"  gemini_key_configured={gemini_cfg.is_configured}")
    if gemini_cfg.api_key:
        print(f"  gemini_key_fingerprint={gemini_cfg.api_key[:4]}…{gemini_cfg.api_key[-4:]}  length={len(gemini_cfg.api_key)}")
    else:
        print("  gemini_key_fingerprint=(none)")
    if settings.provider == "gemini" and active.name == "mock":
        print("  NOTE: Gemini was requested, but no Gemini key was loaded. Put GEMINI_API_KEY=... in backend/.env and restart.\n")
    else:
        print("")

    uvicorn.run(
        "backend.main:app",
        host=host,
        port=port,
        reload=args.reload,
        log_level="debug" if settings.debug else "info",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
