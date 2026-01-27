"""OAuth Preset Manager"""

__version__ = "0.1.0"

from .core import PresetManager
from .cli import main

__all__ = ["PresetManager", "main"]
