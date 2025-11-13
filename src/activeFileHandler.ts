// Active File Handler - Special handling for active file during manual sync
// NOTE: This module is created for FUTURE enhancement.
// Currently, the sync engine uses vault.process() for ALL files (including active).
// This works acceptably even for active files during manual sync.
//
// This module provides editor-based operations if we want to implement special
// handling for active files in the future (e.g., preserving cursor position,
// reading unflushed editor buffer, etc.)

import { App, MarkdownView, TFile, Editor } from 'obsidian';

/**
 * Get the currently active file and its editor if available.
 * Returns null if no markdown file is active or no editor available.
 *
 * @param app - Obsidian app instance
 * @returns Object with file and editor, or null if not available
 */
export function getActiveFileAndEditor(app: App): { file: TFile; editor: Editor } | null {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view) {
		return null;
	}

	const file = view.file;
	const editor = view.editor;

	if (!file || !editor) {
		return null;
	}

	return { file, editor };
}

/**
 * Read content from active file's editor.
 * This includes unflushed changes that haven't been saved to disk yet.
 *
 * @param editor - Obsidian editor instance
 * @returns Current editor content (includes unflushed changes)
 */
export function readActiveFileContent(editor: Editor): string {
	return editor.getValue();
}

/**
 * Update a specific task line in the active editor.
 * Uses editor.replaceRange() to preserve cursor position when possible.
 *
 * @param editor - Obsidian editor instance
 * @param lineNum - 0-based line number to update
 * @param newContent - New content for the line
 */
export function updateTaskLineInEditor(
	editor: Editor,
	lineNum: number,
	newContent: string
): void {
	const line = editor.getLine(lineNum);

	// Replace entire line at lineNum
	editor.replaceRange(
		newContent,
		{ line: lineNum, ch: 0 },
		{ line: lineNum, ch: line.length }
	);
}

/**
 * Get current cursor position.
 * Useful for preserving cursor after edits.
 *
 * @param editor - Obsidian editor instance
 * @returns Cursor position {line: number, ch: number}
 */
export function getCursorPosition(editor: Editor): { line: number; ch: number } {
	return editor.getCursor();
}

/**
 * Set cursor position.
 * Use to restore cursor after programmatic edits.
 *
 * @param editor - Obsidian editor instance
 * @param pos - Position to set cursor {line: number, ch: number}
 */
export function setCursorPosition(editor: Editor, pos: { line: number; ch: number }): void {
	editor.setCursor(pos);
}
