from typing import List, Dict, Optional
from textual import work
from textual.app import App, ComposeResult
from textual.widgets import Header, Footer, Tree, Label, Static, LoadingIndicator
from textual.containers import Container
from textual.binding import Binding
from rich.table import Table
from rich.text import Text
from rich import box

try:
    import pyperclip
    HAS_CLIPBOARD = True
except ImportError:
    HAS_CLIPBOARD = False

from .core import PresetManager, time_until_reset


def _format_percent(value: Optional[int]) -> str:
    if value is None:
        return "-"

    width = 10
    filled_len = int(value / 100 * width)
    if filled_len > width:
        filled_len = width
    if filled_len < 0:
        filled_len = 0
    empty_len = width - filled_len

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


class QuotaApp(App):
    CSS = """
    Tree {
        padding: 1;
        scrollbar-gutter: stable;
    }
    #loading-container {
        height: 100%;
        align: center middle;
        content-align: center middle;
    }
    LoadingIndicator {
        height: auto;
        margin-bottom: 1;
    }
    #loading-label {
        width: 100%;
        text-align: center;
        color: yellow;
    }
    """
    BINDINGS = [
        ("q", "quit", "Quit"),
        ("r", "refresh", "Refresh"),
        ("space", "toggle_node", "Toggle"),
        ("c", "copy_key", "Copy Key"),
    ]

    def __init__(self, manager: PresetManager):
        super().__init__()
        self.manager = manager

    def compose(self) -> ComposeResult:
        yield Header()
        with Container(id="loading-container"):
            yield LoadingIndicator()
            yield Label("Quota 조회 요청 중... (약 5-10초 소요)", id="loading-label")
        yield Tree("OAuth Quotas")
        yield Footer()

    def on_mount(self) -> None:
        self.query_one(Tree).display = False
        self.refresh_data()

    def action_refresh(self) -> None:
        self.refresh_data()

    def action_toggle_node(self) -> None:
        tree = self.query_one(Tree)
        if tree.cursor_node:
            tree.cursor_node.toggle()

    def action_copy_key(self) -> None:
        """Copy account_id from selected node to clipboard"""
        if not HAS_CLIPBOARD:
            self.notify("Clipboard not available (install pyperclip)", severity="warning", timeout=3)
            return
            
        tree = self.query_one(Tree)
        if not tree.cursor_node or not tree.cursor_node.data:
            self.notify("No account selected", severity="warning", timeout=2)
            return
        
        account_id = tree.cursor_node.data.get("account_id")
        if not account_id or account_id == "-":
            self.notify("No account ID available", severity="warning", timeout=2)
            return
        
        try:
            pyperclip.copy(account_id)
            self.notify(f"Copied: {account_id}", timeout=2)
        except Exception as e:
            self.notify(f"Copy failed: {e}", severity="error", timeout=3)

    @work(exclusive=True, thread=True)
    async def refresh_data(self) -> None:
        self.call_from_thread(self.show_loading)

        results = self.manager.collect_all_quota()

        self.call_from_thread(self.update_tree, results)

    def show_loading(self) -> None:
        self.query_one("#loading-container").display = True
        self.query_one(Tree).display = False

    def update_tree(self, results: List[Dict]) -> None:
        self.query_one("#loading-container").display = False
        tree = self.query_one(Tree)
        tree.display = True
        tree.clear()
        tree.root.expand()

        groups: Dict[str, List[Dict]] = {}

        # Determine active label dynamically
        active_label_base = "Current Active"
        for res in results:
            for p in res.get("presets", []):
                if "Current Active" in p:
                    active_label_base = p
                    break
            if active_label_base != "Current Active":
                break

        active_key = f"{active_label_base} / Antigravity"
        groups[active_key] = []

        for res in results:
            presets = res.get("presets", [])
            is_active = False
            preset_names = []

            for p in presets:
                if "Current Active" in p or "Antigravity" in p:
                    is_active = True
                else:
                    preset_names.append(p)

            if is_active:
                groups[active_key].append(res)

            for p_name in preset_names:
                if p_name not in groups:
                    groups[p_name] = []
                groups[p_name].append(res)

        if groups[active_key]:
            active_node = tree.root.add(active_key, expand=False)
            self._add_rows_to_node(active_node, groups[active_key])
            del groups[active_key]

        for name, items in groups.items():
            preset_node = tree.root.add(f"Preset: {name}", expand=True)
            self._add_rows_to_node(preset_node, items)

        tree.focus()

    def _add_rows_to_node(self, node, items: List[Dict]):
        for item in items:
            daily = item.get("daily") or {}
            weekly = item.get("weekly") or {}
            provider = str(item.get("provider", "-"))
            if provider == "google" and daily.get("label"):
                provider = f"google ({daily['label']})"

            daily_str = f"Daily: {_format_percent(daily.get('percent_remaining'))} ({_format_reset(daily.get('reset_time_iso'))})"
            weekly_str = f"Weekly: {_format_percent(weekly.get('percent_remaining'))} ({_format_reset(weekly.get('reset_time_iso'))})"
            account = item.get("account_id") or "-"
            error = item.get("error")

            if error:
                label = f"{provider} | {daily_str} | {weekly_str} | {account} | [red]{error}[/red]"
            else:
                label = f"{provider} | {daily_str} | {weekly_str} | {account}"

            # Attach item data to node for clipboard access
            leaf = node.add_leaf(label)
            leaf.data = item


def run_tui(manager: PresetManager):
    app = QuotaApp(manager)
    app.run()
