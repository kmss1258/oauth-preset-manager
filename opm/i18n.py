"""
OAuth Preset Manager - Internationalization
"""
import os
import locale
from typing import Dict


# Translation dictionary
TRANSLATIONS: Dict[str, Dict[str, str]] = {
    "ko": {
        # Status messages
        "current_preset": "현재 프리셋",
        "last_used_preset": "마지막 사용 프리셋",
        "no_preset_active": "활성화된 프리셋 없음",
        "auth_mismatch": "현재 auth.json이 저장된 프리셋과 일치하지 않습니다",
        "no_presets_found": "프리셋을 찾을 수 없습니다.",
        
        # Menu options
        "select_preset": "전환할 프리셋 선택:",
        "save_new_preset": "💾 새 프리셋 저장",
        "view_description": "📝 설명 보기",
        "delete_preset": "🗑️  프리셋 삭제",
        "exit": "❌ 종료",
        
        # Preset actions
        "enter_preset_name": "프리셋 이름 입력:",
        "enter_description": "설명 입력 (선택사항):",
        "select_watched_services": "변경 사항을 감시할 서비스 선택:",
        "watched_services_help": "이 서비스들은 프리셋 전환 시 미리 선택됩니다",
        "watched_services_prompt": "감시할 서비스:",
        
        # Update options
        "how_to_update": "서비스를 어떻게 업데이트하시겠습니까?",
        "update_all": "🔄 모든 서비스 업데이트",
        "update_selective": "🎯 특정 서비스 선택",
        "update_watched": "⚠️  감시 서비스만 업데이트",
        "cancel": "❌ 취소",
        "select_services_to_update": "업데이트할 서비스 선택:",
        
        # Changes display
        "changes_to_apply": "적용될 변경 사항:",
        "added": "추가",
        "removed": "제거",
        "modified": "수정",
        "unchanged": "변경 없음",
        "watched_services_for_preset": "이 프리셋의 감시 서비스:",
        
        # Confirmation messages
        "switched_to": "프리셋으로 전환했습니다",
        "saved_preset": "프리셋을 저장했습니다",
        "deleted_preset": "프리셋을 삭제했습니다",
        "switch_cancelled": "전환이 취소되었습니다",
        "deletion_cancelled": "삭제가 취소되었습니다",
        "no_changes_detected": "변경 사항이 감지되지 않았습니다. Auth가 이미 프리셋과 동일합니다.",
        "no_services_selected": "선택된 서비스가 없습니다. 업데이트 없이 전환합니다.",
        "no_watched_services_changing": "변경되는 감시 서비스가 없습니다. 업데이트 없이 전환합니다.",
        
        # File operations
        "file_operations": "📁 파일 작업:",
        "from": "원본",
        "to": "대상",
        "backup": "백업",
        "updated_services": "🔄 업데이트된 서비스:",
        
        # Questions
        "continue_managing": "프리셋 관리를 계속하시겠습니까?",
        "save_current_as_preset": "현재 인증을 프리셋으로 저장하시겠습니까?",
        "confirm_delete": "'{name}'을(를) 정말 삭제하시겠습니까?",
        "review_unchanged_services": "업데이트되지 않은 서비스를 개별적으로 검토하시겠습니까?",
        "overwrite_service": "{service} 서비스를 새 토큰으로 덮어쓰시겠습니까?",
        
        # View preset
        "select_preset_to_view": "볼 프리셋 선택:",
        "select_preset_to_delete": "삭제할 프리셋 선택:",
        "preset": "프리셋",
        "services": "서비스",
        "description": "설명",
        "no_description": "설명 없음",
        "created": "생성",
        "last_used": "마지막 사용",
        "watched": "감시 중",
        
        # Errors
        "error": "오류",
        "preset_not_found": "프리셋을 찾을 수 없습니다",
        "auth_file_not_found": "인증 파일을 찾을 수 없습니다",
        "could_not_load_preset": "프리셋 정보를 불러올 수 없습니다",
        
        # Setup
        "found_opencode_auth": "OpenCode 인증을 찾았습니다",
        "auth_not_found": "기본 위치에서 OpenCode auth.json을 찾을 수 없습니다",
        "enter_auth_path": "OpenCode auth.json 경로를 입력하세요:",
        "invalid_path": "잘못된 경로입니다. 종료합니다.",
        "auth_path_set": "인증 경로가 설정되었습니다",
        
        # Tips
        "tip": "팁",
        "run_opm_to_configure": "'opm'을 실행하여 인증 경로를 설정하세요",
        
        # Service comparison
        "service_comparison": "{service} 서비스 비교:",
        "current_token": "현재 토큰",
        "new_token": "새 토큰",
        "services_not_selected": "선택되지 않은 서비스: {services}",
    },
    "en": {
        # Status messages
        "current_preset": "Current preset",
        "last_used_preset": "Last used preset",
        "no_preset_active": "No preset currently active",
        "auth_mismatch": "Current auth.json doesn't match any saved preset",
        "no_presets_found": "No presets found.",
        
        # Menu options
        "select_preset": "Select a preset to switch to:",
        "save_new_preset": "💾 Save new preset",
        "view_description": "📝 View description",
        "delete_preset": "🗑️  Delete preset",
        "exit": "❌ Exit",
        
        # Preset actions
        "enter_preset_name": "Enter preset name:",
        "enter_description": "Enter description (optional):",
        "select_watched_services": "Select services to watch for changes:",
        "watched_services_help": "These services will be pre-selected when switching presets",
        "watched_services_prompt": "Watched services:",
        
        # Update options
        "how_to_update": "How would you like to update the services?",
        "update_all": "🔄 Update all services",
        "update_selective": "🎯 Select specific services to update",
        "update_watched": "⚠️  Update only watched services",
        "cancel": "❌ Cancel",
        "select_services_to_update": "Select services to update:",
        
        # Changes display
        "changes_to_apply": "Changes that will be applied:",
        "added": "Added",
        "removed": "Removed",
        "modified": "Modified",
        "unchanged": "Unchanged",
        "watched_services_for_preset": "Watched services for this preset:",
        
        # Confirmation messages
        "switched_to": "Switched to preset",
        "saved_preset": "Saved preset",
        "deleted_preset": "Deleted preset",
        "switch_cancelled": "Switch cancelled",
        "deletion_cancelled": "Deletion cancelled",
        "no_changes_detected": "No changes detected. Auth is already identical to preset.",
        "no_services_selected": "No services selected. Switching without updates.",
        "no_watched_services_changing": "No watched services are changing. Switching without updates.",
        
        # File operations
        "file_operations": "📁 File Operations:",
        "from": "From",
        "to": "To",
        "backup": "Backup",
        "updated_services": "🔄 Updated Services:",
        
        # Questions
        "continue_managing": "Continue managing presets?",
        "save_current_as_preset": "Would you like to save current auth as a preset?",
        "confirm_delete": "Are you sure you want to delete '{name}'?",
        "review_unchanged_services": "Would you like to review unchanged services individually?",
        "overwrite_service": "Overwrite {service} with new token?",
        
        # View preset
        "select_preset_to_view": "Select a preset to view:",
        "select_preset_to_delete": "Select a preset to delete:",
        "preset": "Preset",
        "services": "Services",
        "description": "Description",
        "no_description": "No description available",
        "created": "Created",
        "last_used": "Last used",
        "watched": "Watched",
        
        # Errors
        "error": "Error",
        "preset_not_found": "Preset not found",
        "auth_file_not_found": "Auth file not found",
        "could_not_load_preset": "Could not load preset info",
        
        # Setup
        "found_opencode_auth": "Found OpenCode auth at",
        "auth_not_found": "OpenCode auth.json not found at default location",
        "enter_auth_path": "Please enter the path to your OpenCode auth.json:",
        "invalid_path": "Invalid path. Exiting.",
        "auth_path_set": "Auth path set to",
        
        # Tips
        "tip": "Tip",
        "run_opm_to_configure": "Run 'opm' to configure auth path",
        
        # Service comparison
        "service_comparison": "{service} Service Comparison:",
        "current_token": "Current token",
        "new_token": "New token",
        "services_not_selected": "Services not selected: {services}",
    }
}


# Current language (will be set on module load)
_current_language: str = "ko"


def detect_language() -> str:
    """Detect user's preferred language from environment or system locale"""
    # 1. Check environment variable
    env_lang = os.getenv("OPM_LANG", "").lower()
    if env_lang in ["ko", "en"]:
        return env_lang
    
    # 2. Check system locale
    try:
        lang, _ = locale.getdefaultlocale()
        if lang and lang.startswith("ko"):
            return "ko"
    except:
        pass
    
    # 3. Default to Korean
    return "ko"


def set_language(lang: str):
    """Set the current language"""
    global _current_language
    if lang in TRANSLATIONS:
        _current_language = lang


def t(key: str, **kwargs) -> str:
    """
    Translate a key to the current language
    
    Args:
        key: Translation key
        **kwargs: Format arguments for the translation string
        
    Returns:
        Translated and formatted string
    """
    translation = TRANSLATIONS.get(_current_language, {}).get(key)
    
    # Fallback to English if key not found in current language
    if translation is None:
        translation = TRANSLATIONS.get("en", {}).get(key)
    
    # Fallback to key itself if not found anywhere
    if translation is None:
        translation = key
    
    # Apply formatting if kwargs provided
    if kwargs:
        try:
            return translation.format(**kwargs)
        except KeyError:
            return translation
    
    return translation


# Auto-detect language on module import
_current_language = detect_language()
