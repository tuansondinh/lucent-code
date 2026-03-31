import {
	Container,
	type Focusable,
	fuzzyFilter,
	getEditorKeybindings,
	Input,
	Spacer,
	Text,
} from "@gsd/pi-tui";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";

interface PaletteItem {
	value: string;
	label: string;
	description: string;
}

const PALETTE_ITEMS: PaletteItem[] = [
	{ value: "session:new", label: "New Session", description: "Session" },
	{ value: "session:switch", label: "Switch Session", description: "Session" },
	{ value: "model:switch", label: "Switch Model", description: "Model" },
	{ value: "thinking:change", label: "Change Thinking Level", description: "Thinking" },
	{ value: "settings:open", label: "Open Settings", description: "Settings" },
	{ value: "commands:compact", label: "Compact Context", description: "Commands" },
	{ value: "commands:clear", label: "Clear Screen", description: "Commands" },
	{ value: "mode:toggle", label: "Toggle Permission Mode", description: "Mode" },
];

/**
 * Command Palette component (Ctrl+K).
 *
 * Renders a fuzzy-searchable list of application actions.
 * Pressing Enter selects the highlighted action; Escape dismisses.
 */
export class CommandPaletteComponent extends Container implements Focusable {
	private searchInput: Input;
	private listContainer: Container;

	private filteredItems: PaletteItem[] = [...PALETTE_ITEMS];
	private selectedIndex = 0;

	// Focusable — propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private onSelectCallback: (actionId: string) => void;
	private onCancelCallback: () => void;

	constructor(onSelect: (actionId: string) => void, onCancel: () => void) {
		super();

		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Title
		this.addChild(new Text(theme.bold(theme.fg("accent", "  Command Palette")), 0, 0));
		this.addChild(new Spacer(1));

		// Search input
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => {
			this.confirmSelection();
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// List container — rendered manually like model-selector.ts
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Hint
		this.addChild(new Text(theme.fg("dim", "  Enter to run · Esc to dismiss"), 0, 0));

		// Bottom border
		this.addChild(new DynamicBorder());

		// Initial render
		this.updateList();
	}

	private confirmSelection(): void {
		const item = this.filteredItems[this.selectedIndex];
		if (item) {
			this.onSelectCallback(item.value);
		}
	}

	private updateFilter(query: string): void {
		this.filteredItems = query
			? (fuzzyFilter(PALETTE_ITEMS, query, (item) => `${item.label} ${item.description}`) as PaletteItem[])
			: [...PALETTE_ITEMS];
		this.selectedIndex = 0;
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching commands"), 0, 0));
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(maxVisible / 2),
				this.filteredItems.length - maxVisible,
			),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredItems.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const categoryBadge = theme.fg("muted", `[${item.description}]`);

			let line: string;
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				line = `${prefix}${theme.fg("accent", item.label)}  ${categoryBadge}`;
			} else {
				line = `  ${item.label}  ${categoryBadge}`;
			}

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Scroll indicator
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
			);
		}
	}

	handleInput(keyData: string): void {
		const kb = getEditorKeybindings();

		// Navigation
		if (kb.matches(keyData, "selectUp")) {
			if (this.filteredItems.length > 0) {
				this.selectedIndex =
					this.selectedIndex === 0
						? this.filteredItems.length - 1
						: this.selectedIndex - 1;
				this.updateList();
			}
			return;
		}

		if (kb.matches(keyData, "selectDown")) {
			if (this.filteredItems.length > 0) {
				this.selectedIndex =
					this.selectedIndex === this.filteredItems.length - 1
						? 0
						: this.selectedIndex + 1;
				this.updateList();
			}
			return;
		}

		// Confirm
		if (kb.matches(keyData, "selectConfirm")) {
			this.confirmSelection();
			return;
		}

		// Cancel
		if (kb.matches(keyData, "selectCancel")) {
			this.onCancelCallback();
			return;
		}

		// Feed remaining input to search
		const prevQuery = this.searchInput.getValue();
		this.searchInput.handleInput(keyData);
		const newQuery = this.searchInput.getValue();

		if (newQuery !== prevQuery) {
			this.updateFilter(newQuery);
		}
	}
}
