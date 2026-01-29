import json
import tempfile
from pathlib import Path
from datetime import datetime, timezone, timedelta

import pytest
import sys

sys.path.insert(0, ".")

from opm.core import time_until_reset, _remaining_percent, _extract_google_oauth


def test_time_until_reset_none():
    result = time_until_reset(None)
    assert result == "-"


def test_time_until_reset_future_1h():
    future = datetime.now(timezone.utc) + timedelta(hours=1, minutes=30)
    iso = future.isoformat()
    result = time_until_reset(iso)
    assert "1h" in result, "Future > 1h should show hours"
    assert "30m" in result or "29m" in result, "Future > 1h should show minutes"


def test_time_until_reset_future_30m():
    future = datetime.now(timezone.utc) + timedelta(minutes=30)
    iso = future.isoformat()
    result = time_until_reset(iso)
    assert "30m" in result or "29m" in result, "Future < 1h should show minutes"
    assert "h" not in result, "Future < 1h should NOT show hours"


def test_time_until_reset_past():
    past = datetime.now(timezone.utc) - timedelta(minutes=10)
    iso = past.isoformat()
    result = time_until_reset(iso)
    assert result == "Resetting...", "Past time should return 'Resetting...'"


def test_remaining_percent():
    assert _remaining_percent({"used_percent": 50}) == 50
    assert _remaining_percent({"used_percent": 0}) == 100
    assert _remaining_percent({"used_percent": 100}) == 0, "Clamp to 0"
    assert _remaining_percent({"used_percent": -50}) == 100, "Clamp to 100"


def test_extract_google_oauth():
    auth_data = {
        "google": {
            "type": "oauth",
            "access": "google_access",
            "refresh": "google_refresh",
            "expires": 1234567890000,
            "project_id": "my-project",
        }
    }
    result = _extract_google_oauth(auth_data)
    assert result is not None
    assert result["access"] == "google_access"
    assert result["refresh"] == "google_refresh"
    assert result["project_id"] == "my-project"

    # Test missing google
    assert _extract_google_oauth({}) is None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
