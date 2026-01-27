"""
OAuth Preset Manager - CLI Interface
"""
import sys
from pathlib import Path
from typing import Optional, List, Dict
import questionary
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich import box

from .core import PresetManager


console = Console()


def setup_auth_path(manager: PresetManager) -> bool:
    """Setup OpenCode auth.json path on first run"""
    default_path = Path.home() / ".local" / "share" / "opencode" / "auth.json"
    
    if default_path.exists():
        console.print(f"[green]✓[/green] Found OpenCode auth at: {default_path}")
        manager.set_auth_path(str(default_path))
        return True
    
    console.print("[yellow]⚠[/yellow] OpenCode auth.json not found at default location")
    
    custom_path = questionary.path(
        "Please enter the path to your OpenCode auth.json:",
        default=str(default_path)
    ).ask()
    
    if custom_path and Path(custom_path).exists():
        manager.set_auth_path(custom_path)
        console.print(f"[green]✓[/green] Auth path set to: {custom_path}")
        return True
    
    console.print("[red]✗[/red] Invalid path. Exiting.")
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
            console.print("\n[yellow]No presets found.[/yellow]")
            save_new = questionary.confirm("Would you like to save current auth as a preset?").ask()
            if save_new:
                save_preset_interactive(manager)
            return
        
        # Display current status
        console.print()
        current = manager.config.get("current_preset")
        if current:
            console.print(f"[bold cyan]Current preset:[/bold cyan] {current}")
        
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
        choices.append({"name": "💾 Save new preset", "value": "__save__"})
        choices.append({"name": "📝 View description", "value": "__view__"})
        choices.append({"name": "🗑️  Delete preset", "value": "__delete__"})
        choices.append({"name": "❌ Exit", "value": "__exit__"})
        
        # Show menu
        selection = questionary.select(
            "Select a preset to switch to:",
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
            # Switch to selected preset
            try:
                result = manager.switch_preset(selection)
                console.print(f"\n[green]✓[/green] Switched to preset: [bold]{selection}[/bold]")
                
                # Show file operation details
                console.print(f"\n[dim]📁 File Operations:[/dim]")
                console.print(f"  [cyan]From:[/cyan] {result['source_path']}")
                console.print(f"  [cyan]To:[/cyan]   {result['destination_path']}")
                if result['backup_path']:
                    console.print(f"  [yellow]Backup:[/yellow] {result['backup_path']}")
                
                # Show diff
                diff = result['diff']
                if diff['added'] or diff['removed'] or diff['modified']:
                    console.print(f"\n[dim]🔄 Auth Changes:[/dim]")
                    
                    if diff['added']:
                        console.print(f"  [green]+ Added:[/green] {', '.join(diff['added'])}")
                    
                    if diff['removed']:
                        console.print(f"  [red]- Removed:[/red] {', '.join(diff['removed'])}")
                    
                    if diff['modified']:
                        console.print(f"  [yellow]~ Modified:[/yellow] {', '.join(diff['modified'])}")
                    
                    if diff['unchanged']:
                        console.print(f"  [dim]= Unchanged:[/dim] {', '.join(diff['unchanged'])}")
                else:
                    console.print(f"\n[dim]No changes in auth services[/dim]")
                
                # Ask if user wants to continue or exit
                continue_choice = questionary.confirm("Continue managing presets?", default=False).ask()
                if not continue_choice:
                    break
                    
            except Exception as e:
                console.print(f"[red]✗[/red] Error: {e}")


def save_preset_interactive(manager: PresetManager):
    """Interactive preset saving"""
    name = questionary.text(
        "Enter preset name:",
        validate=lambda x: len(x) > 0
    ).ask()
    
    if not name:
        return
    
    description = questionary.text(
        "Enter description (optional):",
        default=""
    ).ask()
    
    try:
        manager.save_preset(name, description or "")
        console.print(f"\n[green]✓[/green] Saved preset: [bold]{name}[/bold]")
        
        # Show what was saved
        info = manager.get_preset_info(name)
        if info:
            console.print(f"[dim]Services: {', '.join(info['services'])}[/dim]")
    except Exception as e:
        console.print(f"[red]✗[/red] Error: {e}")


def view_description_interactive(manager: PresetManager, presets: List[Dict]):
    """View preset description"""
    preset_names = [p["name"] for p in presets]
    
    selection = questionary.select(
        "Select a preset to view:",
        choices=preset_names
    ).ask()
    
    if not selection:
        return
    
    info = manager.get_preset_info(selection)
    if info:
        console.print(f"\n[bold cyan]Preset:[/bold cyan] {selection}")
        console.print(f"[bold]Services:[/bold] {', '.join(info['services'])}")
        
        metadata = info.get('metadata', {})
        if metadata.get('description'):
            console.print(f"[bold]Description:[/bold] {metadata['description']}")
        else:
            console.print("[dim]No description available[/dim]")
        
        if metadata.get('created_at'):
            console.print(f"[dim]Created: {metadata['created_at']}[/dim]")
        if metadata.get('last_used'):
            console.print(f"[dim]Last used: {metadata['last_used']}[/dim]")
        
        console.print()


def delete_preset_interactive(manager: PresetManager, presets: List[Dict]):
    """Delete a preset interactively"""
    preset_names = [p["name"] for p in presets]
    
    selection = questionary.select(
        "Select a preset to delete:",
        choices=preset_names
    ).ask()
    
    if not selection:
        return
    
    # Confirm deletion
    confirm = questionary.confirm(
        f"Are you sure you want to delete '{selection}'?",
        default=False
    ).ask()
    
    if not confirm:
        console.print("[yellow]Deletion cancelled[/yellow]")
        return
    
    try:
        manager.delete_preset(selection)
        console.print(f"\n[green]✓[/green] Deleted preset: [bold]{selection}[/bold]")
    except Exception as e:
        console.print(f"[red]✗[/red] Error: {e}")



def cmd_save(manager: PresetManager, name: str):
    """Save current auth as preset"""
    try:
        auth_path = manager.get_auth_path()
        if not auth_path.exists():
            console.print(f"[red]✗[/red] Auth file not found: {auth_path}")
            console.print("[yellow]Tip:[/yellow] Run 'opm' to configure auth path")
            return
        
        manager.save_preset(name)
        console.print(f"[green]✓[/green] Saved preset: [bold]{name}[/bold]")
        
        info = manager.get_preset_info(name)
        if info:
            console.print(f"[dim]Services: {', '.join(info['services'])}[/dim]")
    except Exception as e:
        console.print(f"[red]✗[/red] Error: {e}")


def cmd_switch(manager: PresetManager, name: str):
    """Switch to a preset"""
    try:
        result = manager.switch_preset(name)
        
        console.print(f"\n[green]✓[/green] Switched to preset: [bold]{name}[/bold]")
        
        # Show file operation details
        console.print(f"\n[dim]📁 File Operations:[/dim]")
        console.print(f"  [cyan]From:[/cyan] {result['source_path']}")
        console.print(f"  [cyan]To:[/cyan]   {result['destination_path']}")
        if result['backup_path']:
            console.print(f"  [yellow]Backup:[/yellow] {result['backup_path']}")
        
        # Show diff
        diff = result['diff']
        if diff['added'] or diff['removed'] or diff['modified']:
            console.print(f"\n[dim]🔄 Auth Changes:[/dim]")
            
            if diff['added']:
                console.print(f"  [green]+ Added:[/green] {', '.join(diff['added'])}")
            
            if diff['removed']:
                console.print(f"  [red]- Removed:[/red] {', '.join(diff['removed'])}")
            
            if diff['modified']:
                console.print(f"  [yellow]~ Modified:[/yellow] {', '.join(diff['modified'])}")
            
            if diff['unchanged']:
                console.print(f"  [dim]= Unchanged:[/dim] {', '.join(diff['unchanged'])}")
        else:
            console.print(f"\n[dim]No changes in auth services[/dim]")
        
    except FileNotFoundError:
        console.print(f"[red]✗[/red] Preset not found: {name}")
        console.print("\n[yellow]Available presets:[/yellow]")
        for preset in manager.list_presets():
            console.print(f"  • {preset['name']}")
    except Exception as e:
        console.print(f"[red]✗[/red] Error: {e}")


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
