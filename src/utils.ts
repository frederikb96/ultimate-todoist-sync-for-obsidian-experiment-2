// Utility functions for Todoist Sync Plugin 2.0

// Background processing helpers - yield to UI

// Wait for next animation frame (yields to browser/UI)
export function nextFrame(): Promise<void> {
	return new Promise(resolve => {
		requestAnimationFrame(() => resolve());
	});
}

// Sleep for specified milliseconds
export function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Escape regex special characters for safe pattern matching
export function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Parse TID from task line (%%[tid:: [6fFj3wQx8h8HfQWG]]%%)
export function extractTID(line: string): string | null {
	const tidPattern = /%%\[tid:: \[([A-Za-z0-9]+)\]/;
	const match = line.match(tidPattern);
	return match ? match[1] : null;
}

// Check if line is markdown task (- [ ] or - [x])
export function isMarkdownTask(line: string): boolean {
	const taskPattern = /^\s*-\s+\[([x ])\]/;
	return taskPattern.test(line);
}

// Get task checkbox state (completed or not)
export function isTaskCompleted(line: string): boolean {
	const completedPattern = /^\s*-\s+\[x\]/i;
	return completedPattern.test(line);
}

// Convert Todoist duration to minutes
// API returns {amount: number, unit: "minute" | "day"}
// We always store in minutes internally
export function convertDurationToMinutes(duration: { amount: number; unit: string } | undefined | null): number | undefined {
	if (!duration) return undefined;

	if (duration.unit === "day") {
		// Convert days to minutes (1 day = 1440 minutes)
		return duration.amount * 1440;
	}

	// Already in minutes
	return duration.amount;
}

// Get indentation level from markdown line (2 spaces = 1 level, or 1 tab = 1 level)
export function getIndentLevel(line: string): number {
	const match = line.match(/^(\s*)/);
	if (!match) return 0;

	const whitespace = match[1];
	// Count tabs as 1 level each, spaces as 1 level per 2 spaces
	let level = 0;
	for (const char of whitespace) {
		if (char === '\t') {
			level++;
		} else if (char === ' ') {
			// Count spaces (2 spaces = 1 level, handled after loop)
		}
	}

	// Add space-based levels (2 spaces per level)
	const spaces = whitespace.replace(/\t/g, '').length;
	level += Math.floor(spaces / 2);

	return level;
}

// Get indent unit from Obsidian's editor settings (tabs or spaces)
// Returns "\t" for tabs, or "  "/"    " for spaces depending on user settings
export function getIndentUnit(workspace: any): string {
	try {
		// Access current editor to read CodeMirror indent settings
		const activeView = workspace.getActiveViewOfType(require('obsidian').MarkdownView);
		if (activeView) {
			const editorView = activeView.editor.cm;
			if (editorView && editorView.state) {
				// Import CodeMirror facets dynamically
				const { indentUnit } = require('@codemirror/language');
				const indent = editorView.state.facet(indentUnit);
				return indent; // Returns "\t" or "  " or "    " etc.
			}
		}
	} catch (error) {
		// Silently fall through to default if CodeMirror access fails
	}

	// Fallback: use tab character as default (matches Obsidian's default)
	return '\t';
}

// Build indentation prefix using Obsidian's indent settings
// indentUnit: "\t" for tabs, "  " or "    " for spaces (get from getIndentUnit)
export function buildIndent(level: number, indentUnit: string = '\t'): string {
	return indentUnit.repeat(level);
}
