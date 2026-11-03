import unittest

from pydantic import ValidationError

from app.config import Settings


BASE = {
    "mindful_secret_key": "test-only-secret-key-with-more-than-32-characters",
    "app_env": "production",
    "database_url": "postgresql+psycopg://user:pass@db.example.test:5432/mindful?sslmode=verify-full",
    "cookie_secure": True,
    "frontend_origins": "https://mindful.example.test",
    "allowed_hosts": "api.example.test",
    "rate_limit_storage_uri": "rediss://user:pass@redis.example.test:6379/0",
    "voice_storage_path": "/var/data/mindful-voice",
}


class ProductionSettingsTests(unittest.TestCase):
    def settings(self, **overrides):
        values = {**BASE, **overrides}
        return Settings(_env_file=None, **values)

    def test_accepts_secure_production_configuration(self):
        self.assertEqual(self.settings().session_cookie_samesite, "lax")

    def test_allows_cross_site_cookie_mode_when_secure(self):
        self.assertEqual(self.settings(session_cookie_samesite="none").session_cookie_samesite, "none")

    def test_rejects_insecure_cookie_mode(self):
        with self.assertRaises(ValidationError):
            self.settings(cookie_secure=False)

    def test_rejects_missing_https_origin(self):
        with self.assertRaises(ValidationError):
            self.settings(frontend_origins="http://mindful.example.test")

    def test_rejects_local_database(self):
        with self.assertRaises(ValidationError):
            self.settings(database_url="sqlite:///./mindful.db")


if __name__ == "__main__":
    unittest.main()
