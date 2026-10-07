from backend.config import get_settings

s = get_settings()
c = s.provider_config("gemini")
print("provider:", s.provider)
print("gemini key loaded:", bool(c.api_key))
print("gemini key length:", len(c.api_key))
print("gemini model:", c.model)
print("active provider:", s.active_provider_config().name)
print("env file:", (s.frontend_dir.parent / "backend" / ".env"))
if not c.api_key:
    print("\nGEMINI_API_KEY was not loaded. Check that backend/.env exists and contains GEMINI_API_KEY=YOUR_KEY")
