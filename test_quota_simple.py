import json
import tempfile
from pathlib import Path

import pytest
import sys

sys.path.insert(0, ".")

exec(open("opm/core.py").read(), globals())

_time_until_reset = globals().get("_time_until_reset")
_extract_openai_oauth = globals().get("_extract_openai_oauth")
_remaining_percent = globals().get("_remaining_percent")


def test_time_until_reset_none():
    result = _time_until_reset(None)
    assert result == "-"


def test_remaining_percent():
    assert _remaining_percent({"used_percent": 50}) == 50
    assert _remaining_percent({"used_percent": 0}) == 100
    assert _remaining_percent({"used_percent": 100}) == 0, "Clamp to 0"
    assert _remaining_percent({"used_percent": -50}) == 100, "Clamp to 100"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
