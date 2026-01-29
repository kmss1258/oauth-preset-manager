"""
OAuth Preset Manager - Core functionality
"""

import base64
import json
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, Dict, List, Tuple


class PresetManager:
    """Manages OAuth presets for OpenCode"""

    def __init__(self, config_dir: Optional[Path] = None):
        self.config_dir = config_dir or Path.home() / ".config" / "oauth-preset-manager"
        self.presets_dir = self.config_dir / "presets"
        self.backups_dir = self.config_dir / "backups"
        self.config_file = self.config_dir / "config.json"

        # Create directories
        self.presets_dir.mkdir(parents=True, exist_ok=True)
        self.backups_dir.mkdir(parents=True, exist_ok=True)

        # Load or create config
        self.config = self._load_config()

    def _load_config(self) -> Dict:
        """Load configuration file"""
        if self.config_file.exists():
            with open(self.config_file, "r") as f:
                return json.load(f)

        # Default config
        default_auth_path = Path.home() / ".local" / "share" / "opencode" / "auth.json"
        return {
            "auth_path": str(default_auth_path),
            "current_preset": None,
            "presets": {},
        }

    def _save_config(self):
        """Save configuration file"""
        with open(self.config_file, "w") as f:
            json.dump(self.config, f, indent=2)

    def get_auth_path(self) -> Path:
        """Get the OpenCode auth.json path"""
        return Path(self.config["auth_path"])

    def set_auth_path(self, path: str):
        """Set the OpenCode auth.json path"""
        self.config["auth_path"] = str(path)
        self._save_config()

    def _create_backup(self, name: str = None) -> Optional[Path]:
        """Create a backup of current auth.json"""
        auth_path = self.get_auth_path()
        if not auth_path.exists():
            return None

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_name = name or f"backup_{timestamp}.json"
        backup_path = self.backups_dir / backup_name

        shutil.copy2(auth_path, backup_path)

        # Keep only last 10 backups
        backups = sorted(self.backups_dir.glob("backup_*.json"))
        if len(backups) > 10:
            for old_backup in backups[:-10]:
                old_backup.unlink()

        return backup_path

    def save_preset(
        self, name: str, description: str = "", watched_services: List[str] = None
    ) -> bool:
        """Save current auth.json as a preset"""
        auth_path = self.get_auth_path()

        if not auth_path.exists():
            raise FileNotFoundError(f"Auth file not found: {auth_path}")

        # Validate JSON
        with open(auth_path, "r") as f:
            auth_data = json.load(f)

        # Save preset
        preset_path = self.presets_dir / f"{name}.json"
        shutil.copy2(auth_path, preset_path)

        # Update metadata
        services = list(auth_data.keys())
        now = datetime.now().isoformat()

        # Default watched_services to ["openai"] if not specified
        if watched_services is None:
            watched_services = ["openai"]

        self.config["presets"][name] = {
            "created_at": now,
            "last_used": now,
            "description": description,
            "services": services,
            "watched_services": watched_services,
        }
        self.config["current_preset"] = name
        self._save_config()

        return True

    def _compute_auth_diff(self, old_auth: Dict, new_auth: Dict) -> Dict:
        """Compute differences between two auth files"""
        old_services = set(old_auth.keys())
        new_services = set(new_auth.keys())

        added = new_services - old_services
        removed = old_services - new_services
        common = old_services & new_services

        modified = []
        for service in common:
            if old_auth[service] != new_auth[service]:
                modified.append(service)

        return {
            "added": sorted(list(added)),
            "removed": sorted(list(removed)),
            "modified": sorted(modified),
            "unchanged": sorted(list(common - set(modified))),
        }

    def switch_preset(self, name: str, auto_backup: bool = True) -> Dict:
        """Switch to a different preset and return operation details"""
        preset_path = self.presets_dir / f"{name}.json"

        if not preset_path.exists():
            raise FileNotFoundError(f"Preset not found: {name}")

        auth_path = self.get_auth_path()

        # Read old and new auth data for diff
        old_auth = {}
        if auth_path.exists():
            with open(auth_path, "r") as f:
                old_auth = json.load(f)

        with open(preset_path, "r") as f:
            new_auth = json.load(f)

        # Compute diff
        diff = self._compute_auth_diff(old_auth, new_auth)

        # Create backup before switching
        backup_path = None
        if auto_backup and auth_path.exists():
            backup_path = self._create_backup(
                f"before_{name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            )

        # Copy preset to auth location
        auth_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(preset_path, auth_path)

        # Update metadata
        now = datetime.now().isoformat()
        if name in self.config["presets"]:
            self.config["presets"][name]["last_used"] = now
        self.config["current_preset"] = name
        self._save_config()

        return {
            "success": True,
            "preset_name": name,
            "source_path": str(preset_path),
            "destination_path": str(auth_path),
            "backup_path": str(backup_path) if backup_path else None,
            "diff": diff,
        }

    def switch_preset_selective(
        self, name: str, selected_services: List[str] = None, auto_backup: bool = True
    ) -> Dict:
        """Switch to a preset with optional selective service update

        Args:
            name: Preset name to switch to
            selected_services: List of service names to update. If None, updates all services.
            auto_backup: Whether to create backup before switching

        Returns:
            Dict with operation details including diff and paths
        """
        preset_path = self.presets_dir / f"{name}.json"

        if not preset_path.exists():
            raise FileNotFoundError(f"Preset not found: {name}")

        auth_path = self.get_auth_path()

        # Read old and new auth data
        old_auth = {}
        if auth_path.exists():
            with open(auth_path, "r") as f:
                old_auth = json.load(f)

        with open(preset_path, "r") as f:
            new_auth = json.load(f)

        # Compute diff
        diff = self._compute_auth_diff(old_auth, new_auth)

        # Create backup before switching
        backup_path = None
        if auto_backup and auth_path.exists():
            backup_path = self._create_backup(
                f"before_{name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
            )

        # Merge auth data based on selected services
        if selected_services is None:
            # Update all services (backward compatible)
            merged_auth = new_auth
        else:
            # Start with current auth and update only selected services
            merged_auth = old_auth.copy()
            for service in selected_services:
                if service in new_auth:
                    merged_auth[service] = new_auth[service]
                elif service in merged_auth:
                    # Service exists in current but not in new preset - remove it
                    del merged_auth[service]

        # Write merged auth to file
        auth_path.parent.mkdir(parents=True, exist_ok=True)
        with open(auth_path, "w") as f:
            json.dump(merged_auth, f, indent=2)

        # Update metadata
        now = datetime.now().isoformat()
        if name in self.config["presets"]:
            self.config["presets"][name]["last_used"] = now
        self.config["current_preset"] = name
        self._save_config()

        return {
            "success": True,
            "preset_name": name,
            "source_path": str(preset_path),
            "destination_path": str(auth_path),
            "backup_path": str(backup_path) if backup_path else None,
            "diff": diff,
            "selected_services": selected_services,
        }

    def list_presets(self) -> List[Dict]:
        """List all available presets"""
        presets = []

        for preset_file in sorted(self.presets_dir.glob("*.json")):
            name = preset_file.stem
            metadata = self.config["presets"].get(name, {})

            # Read services from preset file
            try:
                with open(preset_file, "r") as f:
                    data = json.load(f)
                    services = list(data.keys())
            except Exception:
                services = []

            presets.append(
                {
                    "name": name,
                    "created_at": metadata.get("created_at", "Unknown"),
                    "last_used": metadata.get("last_used", "Never"),
                    "description": metadata.get("description", ""),
                    "services": services,
                    "is_current": name == self.config.get("current_preset"),
                }
            )

        return presets

    def get_preset_info(self, name: str) -> Optional[Dict]:
        """Get detailed information about a preset"""
        preset_path = self.presets_dir / f"{name}.json"

        if not preset_path.exists():
            return None

        with open(preset_path, "r") as f:
            data = json.load(f)

        metadata = self.config["presets"].get(name, {})

        return {
            "name": name,
            "services": list(data.keys()),
            "metadata": metadata,
            "is_current": name == self.config.get("current_preset"),
        }

    def delete_preset(self, name: str) -> bool:
        """Delete a preset"""
        preset_path = self.presets_dir / f"{name}.json"

        if not preset_path.exists():
            raise FileNotFoundError(f"Preset not found: {name}")

        # Remove preset file
        preset_path.unlink()

        # Remove from config
        if name in self.config["presets"]:
            del self.config["presets"][name]

        # Clear current_preset if it was the deleted one
        if self.config.get("current_preset") == name:
            self.config["current_preset"] = None

        self._save_config()
        return True

    def detect_current_preset(self) -> Optional[str]:
        """Detect which preset matches current auth.json by comparing content"""
        auth_path = self.get_auth_path()
        if not auth_path.exists():
            return None

        try:
            with open(auth_path, "r") as f:
                current_auth = json.load(f)
        except (json.JSONDecodeError, IOError):
            return None

        # Compare with each preset
        for preset_file in self.presets_dir.glob("*.json"):
            try:
                with open(preset_file, "r") as f:
                    preset_auth = json.load(f)

                # Exact match check
                if current_auth == preset_auth:
                    return preset_file.stem
            except (json.JSONDecodeError, IOError):
                continue

        return None

    def list_preset_auth_data(self) -> List[Tuple[str, Dict]]:
        """Load auth data for all presets"""
        results: List[Tuple[str, Dict]] = []
        for preset_file in sorted(self.presets_dir.glob("*.json")):
            name = preset_file.stem
            try:
                with open(preset_file, "r") as f:
                    data = json.load(f)
            except Exception:
                continue
            if isinstance(data, dict):
                results.append((name, data))
        return results

    def collect_openai_quota(self) -> List[Dict]:
        """Collect OpenAI quota for unique OAuth tokens across presets"""
        token_map: Dict[str, Dict] = {}
        for preset_name, auth_data in self.list_preset_auth_data():
            entry = _extract_openai_oauth(auth_data)
            if not entry:
                continue
            access = entry.get("access")
            if not access:
                continue
            item = token_map.setdefault(
                access,
                {
                    "access": access,
                    "expires": entry.get("expires"),
                    "account_id": entry.get("account_id"),
                    "presets": [],
                },
            )
            item["presets"].append(preset_name)

        results: List[Dict] = []
        for item in token_map.values():
            result = _fetch_openai_quota_for_token(
                access_token=item["access"],
                expires=item.get("expires"),
                account_id=item.get("account_id"),
            )
            result["presets"] = sorted(item["presets"])
            results.append(result)

        return results

    def collect_google_quota(self) -> List[Dict]:
        """Collect Google quota for unique OAuth tokens across presets"""
        token_map: Dict[str, Dict] = {}
        for preset_name, auth_data in self.list_preset_auth_data():
            entry = _extract_google_oauth(auth_data)
            if not entry:
                continue

            # Use refresh token as key if available, else access token
            key = entry.get("refresh") or entry.get("access")
            if not key:
                continue

            item = token_map.setdefault(
                key,
                {
                    "access": entry.get("access"),
                    "refresh": entry.get("refresh"),
                    "project_id": entry.get("project_id"),
                    "presets": [],
                },
            )
            item["presets"].append(preset_name)

        results: List[Dict] = []
        for item in token_map.values():
            res_list = _fetch_google_quota_for_token(
                access_token=item.get("access"),
                refresh_token=item.get("refresh"),
                project_id=item.get("project_id"),
            )
            for res in res_list:
                res["presets"] = sorted(item["presets"])
                results.append(res)

        return results

    def collect_active_quota(self) -> List[Dict]:
        """Collect quota for currently active auth.json and antigravity accounts"""
        results = []

        # 1. Main auth.json
        auth_path = self.get_auth_path()
        if auth_path.exists():
            try:
                with open(auth_path, "r") as f:
                    auth_data = json.load(f)

                # OpenAI
                openai_entry = _extract_openai_oauth(auth_data)
                if openai_entry and openai_entry.get("access"):
                    res = _fetch_openai_quota_for_token(
                        access_token=openai_entry["access"],
                        expires=openai_entry.get("expires"),
                        account_id=openai_entry.get("account_id"),
                    )
                    res["presets"] = ["(Current Active)"]
                    results.append(res)
            except Exception:
                pass

        # 2. Antigravity Accounts
        ag_path = get_antigravity_accounts_path()
        for account in _extract_antigravity_accounts(ag_path):
            res_list = _fetch_google_quota_for_token(
                access_token=None,
                refresh_token=account["refresh"],
                project_id=account["project_id"],
            )
            for res in res_list:
                res["presets"] = [f"(Antigravity: {account.get('email', 'User')})"]
                # Use project_id from account if result doesn't have it
                if (
                    not res.get("account_id")
                    or res.get("account_id") == "unknown-project"
                ):
                    res["account_id"] = account.get("project_id")
                results.append(res)

        return results

    def collect_all_quota(self) -> List[Dict]:
        """Collect quota for all supported providers"""
        active = self.collect_active_quota()
        openai = self.collect_openai_quota()
        # Google presets are often expired and create noise, so we skip them
        # google = self.collect_google_quota()
        return active + openai


ANTIGRAVITY_CLIENT_ID = (
    "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
)
ANTIGRAVITY_CLIENT_SECRET = "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"

OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

GOOGLE_QUOTA_API_URL = (
    "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels"
)
GOOGLE_TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token"

GOOGLE_MODEL_KEYS = {
    "gemini-3-pro-high": "G3Pro",
    "gemini-3-pro-low": "G3Pro",
    "gemini-3-flash": "G3Flash",
    "claude-opus-4-5-thinking": "Claude",
    "claude-opus-4-5": "Claude",
    "gemini-3-pro-image": "G3Image",
}


def _extract_openai_oauth(auth_data: Dict) -> Optional[Dict]:
    entry = auth_data.get("codex") or auth_data.get("openai")
    if not isinstance(entry, dict):
        return None
    if entry.get("type") != "oauth":
        return None
    access = entry.get("access")
    if not access:
        return None
    return {
        "access": access,
        "expires": entry.get("expires"),
        "account_id": entry.get("accountId"),
    }


def _decode_base64url(data: str) -> bytes:
    padding = "=" * ((4 - len(data) % 4) % 4)
    return base64.urlsafe_b64decode((data + padding).encode("ascii"))


def _parse_jwt_payload(token: str) -> Optional[Dict]:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    try:
        payload = json.loads(_decode_base64url(parts[1]))
        if isinstance(payload, dict):
            return payload
    except Exception:
        return None
    return None


def _openai_account_id_from_jwt(token: str) -> Optional[str]:
    payload = _parse_jwt_payload(token) or {}
    auth_section = payload.get("https://api.openai.com/auth")
    if isinstance(auth_section, dict):
        account_id = auth_section.get("chatgpt_account_id")
        if isinstance(account_id, str) and account_id:
            return account_id
    return None


def _reset_time_iso_from_seconds(reset_at_seconds: Optional[float]) -> Optional[str]:
    if not reset_at_seconds:
        return None
    # Auto-detect milliseconds (timestamps in 2026 are around 1.7e9, so 1e11 is safe threshold)
    if reset_at_seconds > 100000000000:
        reset_at_seconds /= 1000
    dt = datetime.fromtimestamp(reset_at_seconds, tz=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _reset_time_iso_from_now(reset_after_seconds: Optional[float]) -> Optional[str]:
    if not reset_after_seconds or reset_after_seconds <= 0:
        return None
    dt = datetime.fromtimestamp(time.time() + reset_after_seconds, tz=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _remaining_percent(window: Dict) -> int:
    used_percent = float(window.get("used_percent", 0))
    remaining = 100 - used_percent
    if remaining < 0:
        return 0
    if remaining > 100:
        return 100
    return int(round(remaining))


def time_until_reset(reset_time_iso: str) -> str:
    """Calculate time remaining until reset from ISO format"""
    if not reset_time_iso:
        return "-"

    try:
        # Fix for Python < 3.11 which doesn't support 'Z' suffix in fromisoformat
        if reset_time_iso.endswith("Z"):
            reset_time_iso = reset_time_iso[:-1] + "+00:00"

        reset_time = datetime.fromisoformat(reset_time_iso)
        if reset_time.tzinfo is None:
            reset_time = reset_time.replace(tzinfo=timezone.utc)

        now = datetime.now(timezone.utc)
        delta = reset_time - now

        if delta.total_seconds() < 0:
            return "Resetting..."

        total_seconds = int(delta.total_seconds())
        hours = total_seconds // 3600
        minutes = (total_seconds % 3600) // 60

        # If less than 1 minute but positive, show 1m
        if total_seconds > 0 and hours == 0 and minutes == 0:
            minutes = 1

        if hours > 0:
            return f"{hours}h {minutes}m"
        return f"{minutes}m"
    except (ValueError, TypeError):
        return "-"


def _fetch_openai_quota_for_token(
    access_token: str,
    expires: Optional[float],
    account_id: Optional[str],
    timeout_seconds: int = 10,
) -> Dict:
    now_ms = int(time.time() * 1000)
    if isinstance(expires, (int, float)) and expires < now_ms:
        return {
            "provider": "openai",
            "account_id": account_id,
            "daily": None,
            "weekly": None,
            "error": "Token expired",
        }

    resolved_account_id = account_id or _openai_account_id_from_jwt(access_token)
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "OpenCode-Quota-Toast/1.0",
    }
    if resolved_account_id:
        headers["ChatGPT-Account-Id"] = resolved_account_id

    request = urllib.request.Request(OPENAI_USAGE_URL, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        return {
            "provider": "openai",
            "account_id": resolved_account_id,
            "daily": None,
            "weekly": None,
            "error": f"OpenAI API error {exc.code}: {body[:120]}",
        }
    except Exception as exc:
        return {
            "provider": "openai",
            "account_id": resolved_account_id,
            "daily": None,
            "weekly": None,
            "error": str(exc),
        }

    rate_limit = data.get("rate_limit") or {}
    primary = rate_limit.get("primary_window")
    secondary = rate_limit.get("secondary_window")

    daily = None
    if isinstance(primary, dict):
        daily = {
            "percent_remaining": _remaining_percent(primary),
            "reset_time_iso": _reset_time_iso_from_seconds(primary.get("reset_at"))
            or _reset_time_iso_from_now(primary.get("reset_after_seconds")),
        }

    weekly = None
    if isinstance(secondary, dict):
        weekly = {
            "percent_remaining": _remaining_percent(secondary),
            "reset_time_iso": _reset_time_iso_from_seconds(secondary.get("reset_at"))
            or _reset_time_iso_from_now(secondary.get("reset_after_seconds")),
        }

    return {
        "provider": "openai",
        "account_id": resolved_account_id,
        "daily": daily,
        "weekly": weekly,
        "error": None,
    }


def _extract_google_oauth(auth_data: Dict) -> Optional[Dict]:
    entry = auth_data.get("google")
    if not isinstance(entry, dict):
        return None
    if entry.get("type") != "oauth":
        return None

    return {
        "access": entry.get("access"),
        "refresh": entry.get("refresh"),
        "expires": entry.get("expires"),
        "project_id": entry.get("project_id")
        or entry.get("project")
        or entry.get("projectId"),
    }


def _refresh_google_token(refresh_token: str) -> Optional[str]:
    if not refresh_token:
        return None

    data = urllib.parse.urlencode(
        {
            "client_id": ANTIGRAVITY_CLIENT_ID,
            "client_secret": ANTIGRAVITY_CLIENT_SECRET,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }
    ).encode("utf-8")

    request = urllib.request.Request(GOOGLE_TOKEN_REFRESH_URL, data=data, method="POST")
    request.add_header("Content-Type", "application/x-www-form-urlencoded")

    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            resp_data = json.loads(response.read().decode("utf-8"))
            return resp_data.get("access_token")
    except Exception:
        return None


def _fetch_google_quota_for_token(
    access_token: Optional[str],
    refresh_token: Optional[str],
    project_id: Optional[str],
    timeout_seconds: int = 10,
) -> List[Dict]:
    token = access_token

    # Refresh logic
    if not token and refresh_token:
        token = _refresh_google_token(refresh_token)

    if not token:
        return [
            {
                "provider": "google",
                "account_id": project_id or "unknown",
                "error": "No access token (Refresh failed)",
            }
        ]

    # Use a dummy project ID if missing
    actual_project_id = project_id or "unknown-project"

    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "antigravity/1.11.9",
        "Content-Type": "application/json",
    }

    body = json.dumps({"project": actual_project_id}).encode("utf-8")

    request = urllib.request.Request(
        GOOGLE_QUOTA_API_URL, headers=headers, data=body, method="POST"
    )

    data = None
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if "401" in str(exc.code) and refresh_token and token == access_token:
            # Refresh and retry
            new_token = _refresh_google_token(refresh_token)
            if new_token:
                headers["Authorization"] = f"Bearer {new_token}"
                request = urllib.request.Request(
                    GOOGLE_QUOTA_API_URL, headers=headers, data=body, method="POST"
                )
                try:
                    with urllib.request.urlopen(
                        request, timeout=timeout_seconds
                    ) as response:
                        data = json.loads(response.read().decode("utf-8"))
                except Exception as exc2:
                    return [
                        {
                            "provider": "google",
                            "account_id": project_id,
                            "error": f"Retry failed: {exc2}",
                        }
                    ]
            else:
                return [
                    {
                        "provider": "google",
                        "account_id": project_id,
                        "error": "Token expired (Refresh failed)",
                    }
                ]
        else:
            msg = str(exc)
            try:
                err_body = exc.read().decode("utf-8")
                msg = f"HTTP {exc.code}: {err_body[:100]}"
            except:
                pass
            return [
                {
                    "provider": "google",
                    "account_id": project_id,
                    "error": msg,
                }
            ]
    except Exception as exc:
        return [
            {
                "provider": "google",
                "account_id": project_id,
                "error": str(exc),
            }
        ]

    if not data:
        return [
            {
                "provider": "google",
                "account_id": project_id,
                "error": "No data received",
            }
        ]

    models = data.get("models", {})
    results = []

    # Iterate over all available models
    for key, model_data in models.items():
        quota_info = model_data.get("quotaInfo")
        if not quota_info:
            continue

        # Determine label based on key (simple heuristic matching)
        label = key
        lower_key = key.lower()

        if "flash" in lower_key:
            label = "G3Flash"
        elif "pro" in lower_key:
            label = "G3Pro"
        elif "claude" in lower_key:
            label = "Claude"
        elif "gpt" in lower_key or "o1" in lower_key:
            label = "GPT/O1"
        elif model_data.get("displayName"):
            label = model_data.get("displayName")

        remaining = quota_info.get("remainingFraction", 0)

        daily_quota = {
            "percent_remaining": int(remaining * 100),
            "reset_time_iso": quota_info.get("resetTime"),
            "label": label,
        }
        results.append(
            {
                "provider": "google",
                "account_id": project_id,
                "daily": daily_quota,
                "weekly": None,
                "error": None,
            }
        )

    if not results:
        return [
            {
                "provider": "google",
                "account_id": project_id,
                "daily": None,
                "weekly": None,
                "error": "No quota info found",
            }
        ]

    # Sort results by label for consistency
    results.sort(key=lambda x: x["daily"]["label"] if x["daily"] else "")
    return results


def get_antigravity_accounts_path() -> Path:
    paths = [
        Path.home() / ".config" / "opencode" / "antigravity-accounts.json",
        Path.home() / ".local" / "share" / "opencode" / "antigravity-accounts.json",
    ]
    for p in paths:
        if p.exists():
            return p
    return paths[0]


def _extract_antigravity_accounts(path: Path) -> List[Dict]:
    if not path.exists():
        return []
    try:
        with open(path, "r") as f:
            data = json.load(f)
        accounts = data.get("accounts", [])
        results = []
        for acc in accounts:
            if acc.get("refreshToken"):
                results.append(
                    {
                        "refresh": acc["refreshToken"],
                        "project_id": acc.get("projectId")
                        or acc.get("managedProjectId"),
                        "email": acc.get("email"),
                    }
                )
        return results
    except Exception:
        return []

    # Use a dummy project ID if missing, might fail but worth a try for some endpoints
    actual_project_id = project_id or "unknown-project"

    headers = {
        "Authorization": f"Bearer {token}",
        "User-Agent": "antigravity/1.11.9",
        "Content-Type": "application/json",
    }

    body = json.dumps({"project": actual_project_id}).encode("utf-8")

    request = urllib.request.Request(
        GOOGLE_QUOTA_API_URL, headers=headers, data=body, method="POST"
    )

    data = None
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # If 401 and we haven't refreshed yet (and have refresh token), try refreshing
        if "401" in str(exc.code) and refresh_token and token == access_token:
            # This means the *original* access token expired. Refresh and retry.
            new_token = _refresh_google_token(refresh_token)
            if new_token:
                headers["Authorization"] = f"Bearer {new_token}"
                request = urllib.request.Request(
                    GOOGLE_QUOTA_API_URL, headers=headers, data=body, method="POST"
                )
                try:
                    with urllib.request.urlopen(
                        request, timeout=timeout_seconds
                    ) as response:
                        data = json.loads(response.read().decode("utf-8"))
                except Exception as exc2:
                    return {
                        "provider": "google",
                        "account_id": project_id,
                        "error": f"Retry failed: {exc2}",
                    }
            else:
                return {
                    "provider": "google",
                    "account_id": project_id,
                    "error": "Token expired (Refresh failed)",
                }
        else:
            msg = str(exc)
            try:
                err_body = exc.read().decode("utf-8")
                msg = f"HTTP {exc.code}: {err_body[:100]}"
            except:
                pass
            return {
                "provider": "google",
                "account_id": project_id,
                "error": msg,
            }
    except Exception as exc:
        return {
            "provider": "google",
            "account_id": project_id,
            "error": str(exc),
        }

    if not data:
        return {
            "provider": "google",
            "account_id": project_id,
            "error": "No data received",
        }

    models = data.get("models", {})
    daily_quota = None

    # Priority: G3Pro > Claude > Flash
    target_keys = ["gemini-3-pro-high", "claude-opus-4-5-thinking", "gemini-3-flash"]

    found_info = None
    model_name = "Unknown"

    for key in target_keys:
        if key in models and models[key].get("quotaInfo"):
            found_info = models[key]["quotaInfo"]
            model_name = GOOGLE_MODEL_KEYS.get(key, key)
            break

    if found_info:
        remaining = found_info.get("remainingFraction", 0)
        daily_quota = {
            "percent_remaining": int(remaining * 100),
            "reset_time_iso": found_info.get("resetTime"),
            "label": model_name,  # Extra field for CLI
        }

    return {
        "provider": "google",
        "account_id": project_id,
        "daily": daily_quota,
        "weekly": None,
        "error": None,
    }


def get_antigravity_accounts_path() -> Path:
    paths = [
        Path.home() / ".config" / "opencode" / "antigravity-accounts.json",
        Path.home() / ".local" / "share" / "opencode" / "antigravity-accounts.json",
    ]
    for p in paths:
        if p.exists():
            return p
    return paths[0]


def _extract_antigravity_accounts(path: Path) -> List[Dict]:
    if not path.exists():
        return []
    try:
        with open(path, "r") as f:
            data = json.load(f)
        accounts = data.get("accounts", [])
        results = []
        for acc in accounts:
            if acc.get("refreshToken"):
                results.append(
                    {
                        "refresh": acc["refreshToken"],
                        "project_id": acc.get("projectId")
                        or acc.get("managedProjectId"),
                        "email": acc.get("email"),
                    }
                )
        return results
    except Exception:
        return []
