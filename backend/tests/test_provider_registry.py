import unittest

from app.services.llm_router import registry


class ProviderRegistryTests(unittest.TestCase):
    def test_openai_compatible_providers_allow_manual_model_entry(self) -> None:
        info_by_name = {item["provider_name"]: item for item in registry.list_provider_info()}

        for provider_name in ("openai", "openrouter", "together", "ollama"):
            with self.subTest(provider=provider_name):
                self.assertIn(provider_name, info_by_name)
                self.assertTrue(
                    info_by_name[provider_name]["supports_custom_model"],
                    f"{provider_name} should allow a manually entered model id",
                )


if __name__ == "__main__":
    unittest.main()
