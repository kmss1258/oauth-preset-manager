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
from rich.panel import Panel
from rich import box

from .core import PresetManager
from .i18n import t


console = Console()


def setup_auth_path(manager: PresetManager) -> bool:
    """Setup OpenCode auth.json path on first run"""
    default_path = Path.home() / ".local" / "share" / "opencode" / "auth.json"
    
    if default_path.exists():
        console.print(f"[green]✓[/green] {t('found_opencode_auth')}: {default_path}")
        manager.set_auth_path(str(default_path))
        return True
    
    console.print(f"[yellow]⚠[/yellow] {t('auth_not_found')}")
    
    custom_path = questionary.path(
        t('enter_auth_path'),
        default=str(default_path)
    ).ask()
    
    if custom_path and Path(custom_path).exists():
        manager.set_auth_path(custom_path)
        console.print(f"[green]✓[/green] {t('auth_path_set')}: {custom_path}")
        return True
    
    console.print(f"[red]✗[/red] {t('invalid_path')}")
    return False


def interactive_mode(manager: PresetManager):
    """Interactive mode with menu selection"""
    
    # Check auth path
    auth_path = manager.get_auth_path()
    if not auth_path.exists():
        if not setup_auth_path(manager):
            return
    
    while True:
        presets = manager.list_presets()
        
        if not presets:
            console.print(f"\n[yellow]{t('no_presets_found')}[/yellow]")
            save_new = questionary.confirm(t('save_current_as_preset')).ask()
            if save_new:
                save_preset_interactive(manager)
            return
        
        # Display current status
        console.print()
        
        # Detect current preset
        detected_preset = manager.detect_current_preset()
        current = manager.config.get("current_preset")
        
        if detected_preset:
            console.print(f"[bold cyan]{t('current_preset')}:[/bold cyan] {detected_preset} [green]✓[/green]")
        elif current:
            console.print(f"[bold cyan]{t('last_used_preset')}:[/bold cyan] {current}")
            console.print(f"[yellow]⚠[/yellow] [dim]{t('auth_mismatch')}[/dim]")
        else:
            console.print(f"[dim]{t('no_preset_active')}[/dim]")
        
        
        # Build choices
        choices = []
        for preset in presets:
            marker = "● " if preset["is_current"] else "  "
            services_str = ", ".join(preset["services"][:3])
            if len(preset["services"]) > 3:
                services_str += "..."
            
            label = f"{marker}{preset['name']:<20} [{services_str}]"
            choices.append({
                "name": label,
                "value": preset["name"]
            })
        
        choices.append(questionary.Separator())
        choices.append({"name": t('save_new_preset'), "value": "__save__"})
        choices.append({"name": t('view_description'), "value": "__view__"})
        choices.append({"name": t('delete_preset'), "value": "__delete__"})
        choices.append({"name": t('exit'), "value": "__exit__"})
        
        # Show menu
        selection = questionary.select(
            t('select_preset'),
            choices=choices
        ).ask()
        
        if selection == "__exit__" or selection is None:
            break
        elif selection == "__save__":
            save_preset_interactive(manager)
        elif selection == "__view__":
            view_description_interactive(manager, presets)
        elif selection == "__delete__":
            delete_preset_interactive(manager, presets)
        else:
            # Switch to selected preset with selective update
            try:
                # First, get the diff to show what would change
                preset_info = manager.get_preset_info(selection)
                if not preset_info:
                    console.print(f"[red]✗[/red] {t('could_not_load_preset')}")
                    continue
                
                # Read current and target auth to compute diff
                auth_path = manager.get_auth_path()
                preset_path = manager.presets_dir / f"{selection}.json"
                
                current_auth = {}
                if auth_path.exists():
                    with open(auth_path, 'r') as f:
                        current_auth = json.load(f)
                
                with open(preset_path, 'r') as f:
                    target_auth = json.load(f)
                
                diff = manager._compute_auth_diff(current_auth, target_auth)
                
                # Check if there are any changes
                has_changes = diff['added'] or diff['removed'] or diff['modified']
                
                if not has_changes:
                    console.print(f"\n[dim]{t('no_changes_detected')}[/dim]")
                    result = manager.switch_preset(selection)
                    console.print(f"[green]✓[/green] {t('switched_to')}: [bold]{selection}[/bold]")
                    continue_choice = questionary.confirm(t('continue_managing'), default=False).ask()
                    if not continue_choice:
                        break
                    continue
                
                # Show diff
                console.print(f"\n[bold]{t('changes_to_apply')}[/bold]")
                if diff['added']:
                    console.print(f"  [green]+ {t('added')}:[/green] {', '.join(diff['added'])}")
                if diff['removed']:
                    console.print(f"  [red]- {t('removed')}:[/red] {', '.join(diff['removed'])}")
                if diff['modified']:
                    console.print(f"  [yellow]~ {t('modified')}:[/yellow] {', '.join(diff['modified'])}")
                
                # Get watched services for this preset
                metadata = preset_info.get('metadata', {})
                watched_services = metadata.get('watched_services', ['openai'])
                
                # Build list of services that would change
                changing_services = list(set(diff['added'] + diff['removed'] + diff['modified']))
                
                if not changing_services:
                    # No changes, just switch
                    result = manager.switch_preset(selection)
                    console.print(f"\n[green]✓[/green] {t('switched_to')}: [bold]{selection}[/bold]")
                else:
                    # Ask user how to handle the changes
                    console.print(f"\n[bold]{t('watched_services_for_preset')}[/bold] {', '.join(watched_services)}")
                    
                    update_choice = questionary.select(
                        t('how_to_update'),
                        choices=[
                            {"name": t('update_watched'), "value": "watched"},
                            {"name": t('update_all'), "value": "all"},
                            {"name": t('update_selective'), "value": "selective"},
                            {"name": t('cancel'), "value": "cancel"}
                        ]
                    ).ask()
                    
                    if update_choice == "cancel":
                        console.print(f"[yellow]{t('switch_cancelled')}[/yellow]")
                        continue
                    elif update_choice == "all":
                        result = manager.switch_preset(selection)
                        selected_services = None
                    elif update_choice == "watched":
                        # Update only watched services that are changing
                        selected_services = [s for s in changing_services if s in watched_services]
                        if not selected_services:
                            console.print(f"[yellow]{t('no_watched_services_changing')}[/yellow]")
                            result = manager.switch_preset(selection)
                        else:
                            result = manager.switch_preset_selective(selection, selected_services)
                    else:  # selective
                        # Let user choose which services to update
                        selected_services = questionary.checkbox(
                            t('select_services_to_update'),
                            choices=[{"name": s, "checked": s in watched_services} for s in changing_services]
                        ).ask()
                        
                        if not selected_services:
                            console.print(f"[yellow]{t('no_services_selected')}[/yellow]")
                            result = manager.switch_preset(selection)
                        else:
                            # Check for unchanged services and ask if user wants to review them
                            all_services = set(current_auth.keys()) | set(target_auth.keys())
                            unchanged_services = sorted(list(all_services - set(selected_services)))
                            
                            if unchanged_services:
                                console.print(f"\n[dim]{t('services_not_selected', services=', '.join(unchanged_services))}[/dim]")
                                review = questionary.confirm(t('review_unchanged_services'), default=False).ask()
                                
                                if review:
                                    # Review each unchanged service
                                    for service in unchanged_services:
                                        console.print(f"\n[bold]{t('service_comparison', service=service)}[/bold]")
                                        
                                        # Show token preview
                                        if service in current_auth:
                                            current_preview = str(current_auth[service])[:50] + "..." if len(str(current_auth[service])) > 50 else str(current_auth[service])
                                            console.print(f"  [cyan]{t('current_token')}:[/cyan] {current_preview}")
                                        else:
                                            console.print(f"  [cyan]{t('current_token')}:[/cyan] [dim](없음 / none)[/dim]")
                                        
                                        if service in target_auth:
                                            new_preview = str(target_auth[service])[:50] + "..." if len(str(target_auth[service])) > 50 else str(target_auth[service])
                                            console.print(f"  [green]{t('new_token')}:[/green] {new_preview}")
                                        else:
                                            console.print(f"  [green]{t('new_token')}:[/green] [dim](없음 / none)[/dim]")
                                        
                                        overwrite = questionary.confirm(
                                            t('overwrite_service', service=service),
                                            default=False
                                        ).ask()
                                        
                                        if overwrite:
                                            selected_services.append(service)
                            
                            result = manager.switch_preset_selective(selection, selected_services)
                    
                    console.print(f"\n[green]✓[/green] {t('switched_to')}: [bold]{selection}[/bold]")
                    
                    # Show file operation details
                    console.print(f"\n[dim]{t('file_operations')}[/dim]")
                    console.print(f"  [cyan]{t('from')}:[/cyan] {result['source_path']}")
                    console.print(f"  [cyan]{t('to')}:[/cyan]   {result['destination_path']}")
                    if result['backup_path']:
                        console.print(f"  [yellow]{t('backup')}:[/yellow] {result['backup_path']}")
                    
                    # Show what was actually updated
                    if result.get('selected_services'):
                        console.print(f"\n[dim]{t('updated_services')}[/dim]")
                        console.print(f"  {', '.join(result['selected_services'])}")
                
                # Ask if user wants to continue or exit
                continue_choice = questionary.confirm(t('continue_managing'), default=False).ask()
                if not continue_choice:
                    break
                    
            except Exception as e:
                console.print(f"[red]✗[/red] {t('error')}: {e}")




def save_preset_interactive(manager: PresetManager):
    """Interactive preset saving"""
    name = questionary.text(
        t('enter_preset_name'),
        validate=lambda x: len(x) > 0
    ).ask()
    
    if not name:
        return
    
    description = questionary.text(
        t('enter_description'),
        default=""
    ).ask()
    
    # Get current auth services for watched services selection
    auth_path = manager.get_auth_path()
    available_services = []
    if auth_path.exists():
        try:
            with open(auth_path, 'r') as f:
                auth_data = json.load(f)
                available_services = list(auth_data.keys())
        except:
            pass
    
    # Prompt for watched services
    watched_services = ["openai"]  # default
    if available_services:
        console.print(f"\n[bold]{t('select_watched_services')}[/bold]")
        console.print(f"[dim]{t('watched_services_help')}[/dim]")
        
        watched_services = questionary.checkbox(
            t('watched_services_prompt'),
            choices=[{"name": s, "checked": s == "openai"} for s in available_services]
        ).ask()
        
        if not watched_services:
            watched_services = ["openai"]  # fallback to default
    
    try:
        manager.save_preset(name, description or "", watched_services)
        console.print(f"\n[green]✓[/green] {t('saved_preset')}: [bold]{name}[/bold]")
        
        # Show what was saved
        info = manager.get_preset_info(name)
        if info:
            console.print(f"[dim]{t('services')}: {', '.join(info['services'])}[/dim]")
            console.print(f"[dim]{t('watched')}: {', '.join(watched_services)}[/dim]")
    except Exception as e:
        console.print(f"[red]✗[/red] {t('error')}: {e}")



def view_description_interactive(manager: PresetManager, presets: List[Dict]):
    """View preset description"""
    preset_names = [p["name"] for p in presets]
    
    selection = questionary.select(
        t('select_preset_to_view'),
        choices=preset_names
    ).ask()
    
    if not selection:
        return
    
    info = manager.get_preset_info(selection)
    if info:
        console.print(f"\n[bold cyan]{t('preset')}:[/bold cyan] {selection}")
        console.print(f"[bold]{t('services')}:[/bold] {', '.join(info['services'])}")
        
        metadata = info.get('metadata', {})
        if metadata.get('description'):
            console.print(f"[bold]{t('description')}:[/bold] {metadata['description']}")
        else:
            console.print(f"[dim]{t('no_description')}[/dim]")
        
        if metadata.get('created_at'):
            console.print(f"[dim]{t('created')}: {metadata['created_at']}[/dim]")
        if metadata.get('last_used'):
            console.print(f"[dim]{t('last_used')}: {metadata['last_used']}[/dim]")
        
        console.print()


def delete_preset_interactive(manager: PresetManager, presets: List[Dict]):
    """Delete a preset interactively"""
    preset_names = [p["name"] for p in presets]
    
    selection = questionary.select(
        t('select_preset_to_delete'),
        choices=preset_names
    ).ask()
    
    if not selection:
        return
    
    # Confirm deletion
    confirm = questionary.confirm(
        t('confirm_delete', name=selection),
        default=False
    ).ask()
    
    if not confirm:
        console.print(f"[yellow]{t('deletion_cancelled')}[/yellow]")
        return
    
    try:
        manager.delete_preset(selection)
        console.print(f"\n[green]✓[/green] {t('deleted_preset')}: [bold]{selection}[/bold]")
    except Exception as e:
        console.print(f"[red]✗[/red] {t('error')}: {e}")



def cmd_save(manager: PresetManager, name: str):
    """Save current auth as preset"""
    try:
        auth_path = manager.get_auth_path()
        if not auth_path.exists():
            console.print(f"[red]✗[/red] {t('auth_file_not_found')}: {auth_path}")
            console.print(f"[yellow]{t('tip')}:[/yellow] {t('run_opm_to_configure')}")
            return
        
        manager.save_preset(name)
        console.print(f"[green]✓[/green] {t('saved_preset')}: [bold]{name}[/bold]")
        
        info = manager.get_preset_info(name)
        if info:
            console.print(f"[dim]{t('services')}: {', '.join(info['services'])}[/dim]")
    except Exception as e:
        console.print(f"[red]✗[/red] {t('error')}: {e}")


def cmd_switch(manager: PresetManager, name: str):
    """Switch to a preset"""
    try:
        result = manager.switch_preset(name)
        
        console.print(f"\n[green]✓[/green] {t('switched_to')}: [bold]{name}[/bold]")
        
        # Show file operation details
        console.print(f"\n[dim]{t('file_operations')}[/dim]")
        console.print(f"  [cyan]{t('from')}:[/cyan] {result['source_path']}")
        console.print(f"  [cyan]{t('to')}:[/cyan]   {result['destination_path']}")
        if result['backup_path']:
            console.print(f"  [yellow]{t('backup')}:[/yellow] {result['backup_path']}")
        
        # Show diff
        diff = result['diff']
        if diff['added'] or diff['removed'] or diff['modified']:
            console.print(f"\n[dim]🔄 {t('updated_services')}[/dim]")
            
            if diff['added']:
                console.print(f"  [green]+ {t('added')}:[/green] {', '.join(diff['added'])}")
            
            if diff['removed']:
                console.print(f"  [red]- {t('removed')}:[/red] {', '.join(diff['removed'])}")
            
            if diff['modified']:
                console.print(f"  [yellow]~ {t('modified')}:[/yellow] {', '.join(diff['modified'])}")
            
            if diff['unchanged']:
                console.print(f"  [dim]= {t('unchanged')}:[/dim] {', '.join(diff['unchanged'])}")
        else:
            console.print(f"\n[dim]{t('no_changes_detected')}[/dim]")
        
    except FileNotFoundError:
        console.print(f"[red]✗[/red] {t('preset_not_found')}: {name}")
        console.print(f"\n[yellow]{t('tip')}:[/yellow]")
        for preset in manager.list_presets():
            console.print(f"  • {preset['name']}")
    except Exception as e:
        console.print(f"[red]✗[/red] {t('error')}: {e}")


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
    
    else:
        console.print(f"[red]✗[/red] Unknown command: {command}")
        console.print("\n[bold]Usage:[/bold]")
        console.print("  opm              # Interactive mode")
        console.print("  opm save <name>  # Save current auth as preset")
        console.print("  opm switch <name> # Switch to preset")


if __name__ == "__main__":
    main()
