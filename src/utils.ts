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

// Parse TID from task line (%%[tid:: [123456789]]%%)
export function extractTID(line: string): string | null {
	const tidPattern = /%%\[tid:: \[(\d+)\]/;
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
