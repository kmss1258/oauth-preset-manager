"""
OAuth Preset Manager - CLI Interface
"""

import sys
import json
from pathlib import Path
from typing import Optional, List, Dict
import questionary
from rich.console import Console
from rich.table import Table
from rich import box

from .core import PresetManager, time_until_reset
from .i18n import t


console = Console()


def _format_percent(value: Optional[int]) -> str:
    if value is None:
        return "-"

    # Create progress bar (ASCII for safety against font issues)
    # Total width: 10 chars. value is percentage (0-100)
    width = 10
    filled_len = int(value / 100 * width)
    if filled_len > width:
        filled_len = width
    if filled_len < 0:
        filled_len = 0
    empty_len = width - filled_len

    # Using standard ASCII chars
    bar = "=" * filled_len + "-" * empty_len

    color = "green"
    if value < 20:
        color = "red"
    elif value < 50:
        color = "yellow"

    return f"[{color}][{bar}][/{color}] {value:>3}%"


def _format_reset(value: Optional[str]) -> str:
    if not value:
        return "-"
    return time_until_reset(value)


def _render_quota_table(results: List[Dict]):
    if not results:
        console.print(f"[dim]{t('quota_no_results')}[/dim]")
        return

    table = Table(title=t("quota_title"), box=box.SIMPLE)
    table.add_column(t("quota_provider"), style="cyan", no_wrap=True)
    table.add_column(t("quota_account"))
    table.add_column(t("quota_daily"), justify="right")
    table.add_column(t("quota_daily_reset"))
    table.add_column(t("quota_weekly"), justify="right")
    table.add_column(t("quota_weekly_reset"))
    table.add_column(t("quota_presets"))
    table.add_column(t("quota_error"))

    active_rows = []
    preset_rows = []

    for result in results:
        daily = result.get("daily") or {}
        weekly = result.get("weekly") or {}
        account = result.get("account_id") or "-"
        presets_list = result.get("presets", [])
        presets = ", ".join(presets_list)
        error = result.get("error") or "-"

        provider = str(result.get("provider", "-"))
        # Show Google model name
        if provider == "google" and daily.get("label"):
            provider = f"google\n({daily['label']})"

        row = (
            provider,
            account,
            _format_percent(daily.get("percent_remaining")),
            _format_reset(daily.get("reset_time_iso")),
            _format_percent(weekly.get("percent_remaining")),
            _format_reset(weekly.get("reset_time_iso")),
            presets or "-",
            error,
        )

        if "(Current Active)" in presets_list:
            active_rows.append(row)
        else:
            preset_rows.append(row)

    for row in active_rows:
        table.add_row(*row)

    if active_rows and preset_rows:
        table.add_section()

    for row in preset_rows:
        table.add_row(*row)

    console.print(table)


def setup_auth_path(manager: PresetManager) -> bool:
    """Setup OpenCode auth.json path on first run"""
    default_path = Path.home() / ".local" / "share" / "opencode" / "auth.json"

    if default_path.exists():
        console.print(f"[green]✓[/green] {t('found_opencode_auth')}: {default_path}")
        manager.set_auth_path(str(default_path))
        return True

    console.print(f"[yellow]⚠[/yellow] {t('auth_not_found')}")

    custom_path = questionary.path(
        t("enter_auth_path"), default=str(default_path)
    ).ask()

    if custom_path and Path(custom_path).exists():
        manager.set_auth_path(custom_path)
        console.print(f"[green]✓[/green] {t('auth_path_set')}: {custom_path}")
        return True

    console.print(f"[red]✗[/red] {t('invalid_path')}")
    return False


def view_description_interactive(manager: PresetManager, presets: List[Dict]):
    """Show descriptions for all presets"""
    table = Table(title=t("preset_descriptions"), box=box.SIMPLE)
    table.add_column(t("preset_name"), style="cyan")
    table.add_column(t("description"))
    table.add_column(t("watched_services"), style="dim")
    table.add_column(t("last_used"), style="dim")

    for p in presets:
        info = manager.get_preset_info(p["name"])
        meta = info.get("metadata", {}) if info else {}
        watched = ", ".join(meta.get("watched_services", ["openai"]))
        table.add_row(
            p["name"] + (" *" if p["is_current"] else ""),
            meta.get("description", ""),
            watched,
            p.get("last_used", ""),
        )
    console.print(table)
    questionary.press_any_key_to_continue().ask()


def save_preset_interactive(manager: PresetManager):
    """Save preset interactively"""
    auth_path = manager.get_auth_path()
    if not auth_path.exists():
        console.print(f"[red]✗[/red] {t('auth_file_not_found')}")
        return

    name = questionary.text(
        t("enter_preset_name"),
        validate=lambda text: True if text and len(text) > 0 else t("name_required"),
    ).ask()

    if not name:
        return

    description = questionary.text(t("enter_description")).ask()

    # Detect available services
    available_services = []
    try:
        with open(auth_path, "r") as f:
            data = json.load(f)
            available_services = list(data.keys())
    except:
        pass

    watched_services = ["openai"]
    if available_services:
        watched_services = questionary.checkbox(
            t("watched_services_prompt"),
            choices=[{"name": s, "checked": s == "openai"} for s in available_services],
        ).ask()
        if not watched_services:
            watched_services = ["openai"]

    try:
        manager.save_preset(name, description or "", watched_services)
        console.print(f"\n[green]✓[/green] {t('saved_preset')}: [bold]{name}[/bold]")
    except Exception as e:
        console.print(f"[red]✗[/red] {t('error')}: {e}")


def delete_preset_interactive(manager: PresetManager, presets: List[Dict]):
    """Delete preset interactively"""
    if not presets:
        return

    choices = [p["name"] for p in presets]
    selection = questionary.select(t("select_preset_to_delete"), choices=choices).ask()

    if not selection:
        return

    confirm = questionary.confirm(
        t("confirm_delete", name=selection), default=False
    ).ask()

    if confirm:
        try:
            manager.delete_preset(selection)
            console.print(
                f"\n[green]✓[/green] {t('deleted_preset')}: [bold]{selection}[/bold]"
            )
        except Exception as e:
            console.print(f"[red]✗[/red] {t('error')}: {e}")


def cmd_save(manager: PresetManager, name: str):
    """Save current auth as preset"""
    try:
        auth_path = manager.get_auth_path()
        if not auth_path.exists():
            console.print(f"[red]✗[/red] {t('auth_file_not_found')}: {auth_path}")
            return

        manager.save_preset(name)
        console.print(f"[green]✓[/green] {t('saved_preset')}: [bold]{name}[/bold]")
    except Exception as e:
        console.print(f"[red]✗[/red] {t('error')}: {e}")


def cmd_switch(manager: PresetManager, name: str):
    """Switch to a preset"""
    try:
        result = manager.switch_preset(name)
        console.print(f"\n[green]✓[/green] {t('switched_to')}: [bold]{name}[/bold]")

        diff = result.get("diff", {})
        if diff.get("added") or diff.get("removed") or diff.get("modified"):
            console.print(f"\n[dim]🔄 {t('updated_services')}[/dim]")
            if diff.get("added"):
                console.print(
                    f"  [green]+ {t('added')}:[/green] {', '.join(diff['added'])}"
                )
            if diff.get("removed"):
                console.print(
                    f"  [red]- {t('removed')}:[/red] {', '.join(diff['removed'])}"
                )
            if diff.get("modified"):
                console.print(
                    f"  [yellow]~ {t('modified')}:[/yellow] {', '.join(diff['modified'])}"
                )
        else:
            console.print(f"\n[dim]{t('no_changes_detected')}[/dim]")

    except FileNotFoundError:
        console.print(f"[red]✗[/red] {t('preset_not_found')}: {name}")
    except Exception as e:
        console.print(f"[red]✗[/red] {t('error')}: {e}")


def cmd_quota(manager: PresetManager):
    try:
        from .tui import run_tui

        run_tui(manager)
    except ImportError:
        results = manager.collect_all_quota()
        _render_quota_table(results)


def interactive_mode(manager: PresetManager):
    """Interactive mode with menu selection"""

    # Check auth path
    auth_path = manager.get_auth_path()
    if not auth_path.exists():
        if not setup_auth_path(manager):
            return

    mismatch_prompted = False

    while True:
        presets = manager.list_presets()

        if not presets:
            console.print(f"\n[yellow]{t('no_presets_found')}[/yellow]")
            save_new = questionary.confirm(t("save_current_as_preset")).ask()
            if save_new:
                save_preset_interactive(manager)
            return

        # Display current status
        console.print()

        # Detect current preset
        detected_preset = manager.detect_current_preset()
        current = manager.config.get("current_preset")

        if not mismatch_prompted and current and detected_preset != current:
            active_label = detected_preset or t("no_preset_active")
            console.print(f"[yellow]⚠[/yellow] [dim]{t('auth_mismatch')}[/dim]")
            overwrite = questionary.confirm(
                t("overwrite_current_preset", preset=current, active=active_label),
                default=False,
            ).ask()
            mismatch_prompted = True
            if overwrite:
                try:
                    manager.switch_preset(current)
                    detected_preset = current
                    console.print(
                        f"[green]✓[/green] {t('switched_to')}: [bold]{current}[/bold]"
                    )
                except Exception as e:
                    console.print(f"[red]✗[/red] {t('error')}: {e}")

        # Show status
        if current:
            console.print(f"[bold cyan]{t('last_used_preset')}:[/bold cyan] {current}")
        else:
            console.print(f"[dim]{t('no_preset_active')}[/dim]")

        # Menu
        choices = []
        for p in presets:
            choices.append(questionary.Choice(p["name"], value=p["name"]))

        choices.append(questionary.Separator())
        choices.append(questionary.Choice(t("save_new_preset"), value="__save__"))
        choices.append(questionary.Choice(t("view_description"), value="__view__"))
        choices.append(questionary.Choice(t("view_quota"), value="__quota__"))
        choices.append(questionary.Choice(t("delete_preset"), value="__delete__"))
        choices.append(questionary.Choice(t("exit"), value="__exit__"))

        # Verify default exists
        default_val = None
        if current:
            for p in presets:
                if p["name"] == current:
                    default_val = current
                    break

        selection = questionary.select(
            t("select_preset"),
            choices=choices,
            default=default_val,
        ).ask()

        if not selection or selection == "__exit__":
            return
        elif selection == "__save__":
            save_preset_interactive(manager)
        elif selection == "__view__":
            view_description_interactive(manager, presets)
        elif selection == "__quota__":
            cmd_quota(manager)
        elif selection == "__delete__":
            delete_preset_interactive(manager, presets)
        else:
            cmd_switch(manager, selection)


def main():
    """Main CLI entry point"""
    manager = PresetManager()

    args = sys.argv[1:]

    # No arguments - interactive mode
    if not args:
        interactive_mode(manager)
        return

    # Parse commands
    command = args[0]

    if command == "save":
        if len(args) < 2:
            console.print("[red]✗[/red] Usage: opm save <preset-name>")
            return
        cmd_save(manager, args[1])

    elif command == "switch":
        if len(args) < 2:
            console.print("[red]✗[/red] Usage: opm switch <preset-name>")
            return
        cmd_switch(manager, args[1])

    elif command in {"q", "quota"}:
        cmd_quota(manager)

    else:
        console.print(f"[red]✗[/red] Unknown command: {command}")
        console.print("\n[bold]Usage:[/bold]")
        console.print("  opm              # Interactive mode")
        console.print("  opm save <name>  # Save current auth as preset")
        console.print("  opm switch <name> # Switch to preset")
        console.print("  opm quota         # Show OAuth quota for presets")


if __name__ == "__main__":
    main()
