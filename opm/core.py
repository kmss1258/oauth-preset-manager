"""
OAuth Preset Manager - Core functionality
"""
import json
import shutil
from pathlib import Path
from datetime import datetime
from typing import Optional, Dict, List


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
            with open(self.config_file, 'r') as f:
                return json.load(f)
        
        # Default config
        default_auth_path = Path.home() / ".local" / "share" / "opencode" / "auth.json"
        return {
            "auth_path": str(default_auth_path),
            "current_preset": None,
            "presets": {}
        }
    
    def _save_config(self):
        """Save configuration file"""
        with open(self.config_file, 'w') as f:
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
    
    def save_preset(self, name: str, description: str = "", watched_services: List[str] = None) -> bool:
        """Save current auth.json as a preset"""
        auth_path = self.get_auth_path()
        
        if not auth_path.exists():
            raise FileNotFoundError(f"Auth file not found: {auth_path}")
        
        # Validate JSON
        with open(auth_path, 'r') as f:
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
            "watched_services": watched_services
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
            "unchanged": sorted(list(common - set(modified)))
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
            with open(auth_path, 'r') as f:
                old_auth = json.load(f)
        
        with open(preset_path, 'r') as f:
            new_auth = json.load(f)
        
        # Compute diff
        diff = self._compute_auth_diff(old_auth, new_auth)
        
        # Create backup before switching
        backup_path = None
        if auto_backup and auth_path.exists():
            backup_path = self._create_backup(f"before_{name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
        
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
            "diff": diff
        }
    
    def switch_preset_selective(self, name: str, selected_services: List[str] = None, auto_backup: bool = True) -> Dict:
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
            with open(auth_path, 'r') as f:
                old_auth = json.load(f)
        
        with open(preset_path, 'r') as f:
            new_auth = json.load(f)
        
        # Compute diff
        diff = self._compute_auth_diff(old_auth, new_auth)
        
        # Create backup before switching
        backup_path = None
        if auto_backup and auth_path.exists():
            backup_path = self._create_backup(f"before_{name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
        
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
        with open(auth_path, 'w') as f:
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
            "selected_services": selected_services
        }
    
    def list_presets(self) -> List[Dict]:
        """List all available presets"""
        presets = []
        
        for preset_file in sorted(self.presets_dir.glob("*.json")):
            name = preset_file.stem
            metadata = self.config["presets"].get(name, {})
            
            # Read services from preset file
            try:
                with open(preset_file, 'r') as f:
                    data = json.load(f)
                    services = list(data.keys())
            except:
                services = []
            
            presets.append({
                "name": name,
                "created_at": metadata.get("created_at", "Unknown"),
                "last_used": metadata.get("last_used", "Never"),
                "description": metadata.get("description", ""),
                "services": services,
                "is_current": name == self.config.get("current_preset")
            })
        
        return presets
    
    def get_preset_info(self, name: str) -> Optional[Dict]:
        """Get detailed information about a preset"""
        preset_path = self.presets_dir / f"{name}.json"
        
        if not preset_path.exists():
            return None
        
        with open(preset_path, 'r') as f:
            data = json.load(f)
        
        metadata = self.config["presets"].get(name, {})
        
        return {
            "name": name,
            "services": list(data.keys()),
            "metadata": metadata,
            "is_current": name == self.config.get("current_preset")
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
            with open(auth_path, 'r') as f:
                current_auth = json.load(f)
        except (json.JSONDecodeError, IOError):
            return None
        
        # Compare with each preset
        for preset_file in self.presets_dir.glob("*.json"):
            try:
                with open(preset_file, 'r') as f:
                    preset_auth = json.load(f)
                
                # Exact match check
                if current_auth == preset_auth:
                    return preset_file.stem
            except (json.JSONDecodeError, IOError):
                continue
        
        return None

