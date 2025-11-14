// Task Parser - Pure parsing functions (markdown ↔ TaskData)
// Converts markdown task lines to structured data and vice versa

import { TaskData } from './types';
import { extractTID, isMarkdownTask, isTaskCompleted } from './utils';

// ============================================================================
// CORE PARSING FUNCTIONS
// ============================================================================

/**
 * Parse a markdown task line into TaskData structure.
 * Returns TaskData if valid task, null otherwise.
 */
export function parseTaskLine(line: string): TaskData | null {
	if (!isMarkdownTask(line)) {
		return null;
	}

	const content = parseTaskContent(line);
	if (!content) {
		return null; // Malformed task with no content
	}

	return {
		content,
		completed: isTaskCompleted(line),
		labels: parseLabels(line),
		dueDate: parseDueDate(line),
		dueTime: parseDueTime(line),
		dueDatetime: parseDueDatetime(line),
		priority: parsePriority(line),
		duration: parseDuration(line),
		tid: extractTID(line) || undefined
	};
}

/**
 * Extract pure task content (strip ALL metadata).
 * Returns text between checkbox and first metadata marker.
 */
export function parseTaskContent(line: string): string {
	// Remove checkbox prefix
	let content = line.replace(/^\s*-\s+\[([x ])\]\s*/, '');

	// Remove all metadata from end to beginning (order matters!)
	// Remove TID comment: %%[tid:: ...]%%
	content = content.replace(/\s*%%\[tid::[^\]]*\][^\]]*\]%%\s*$/, '');

	// Remove #tdsync tag
	content = content.replace(/\s*#tdsync\s*$/, '');

	// Remove duration: ⏳...
	content = content.replace(/\s*⏳\s*\d+(?:min|h|m)\s*$/, '');
	content = content.replace(/\s*⏳\s*\d+h\d+m\s*$/, '');

	// Remove due time: ⏰HH:MM
	content = content.replace(/\s*⏰\s*\d{1,2}:\d{2}\s*$/, '');

	// Remove due date/datetime: 🗓️YYYY-MM-DD or 🗓️YYYY-MM-DDTHH:MM:SS or 📅...
	content = content.replace(/\s*(?:🗓️|📅)\s*\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?\s*$/, '');

	// Remove priority: !!1-4 or emoji (⏫ ⏬ 🔼 🔽)
	content = content.replace(/\s*!![1-4]\s*$/, '');
	content = content.replace(/\s*(?:⏫|⏬|🔼|🔽)\s*$/, '');

	// Remove ALL hashtag labels (including user labels, not just #tdsync)
	content = content.replace(/\s*#[\w-]+/g, '');

	return content.trim();
}

/**
 * Extract hashtag labels from task line (excluding #tdsync).
 * Returns array of label names (without # prefix).
 */
export function parseLabels(line: string): string[] {
	const labels: string[] = [];
	const labelPattern = /#([\w-]+)/g;
	let match;

	while ((match = labelPattern.exec(line)) !== null) {
		const label = match[1];
		labels.push(label);
	}

	return labels;
}

/**
 * Extract due date from task line.
 * Supports both 🗓️ and 📅 emojis.
 * Returns date in YYYY-MM-DD format, or undefined if not found.
 */
export function parseDueDate(line: string): string | undefined {
	const datePattern = /(?:🗓️|📅)\s*(\d{4}-\d{2}-\d{2})/;
	const match = line.match(datePattern);
	return match ? match[1] : undefined;
}

/**
 * Extract due time from task line.
 * Returns time in HH:MM format, or undefined if not found.
 */
export function parseDueTime(line: string): string | undefined {
	const timePattern = /⏰\s*(\d{1,2}:\d{2})/;
	const match = line.match(timePattern);
	return match ? match[1] : undefined;
}

/**
 * Parse combined due datetime (date + time).
 * Returns ISO datetime string if both date and time present.
 */
export function parseDueDatetime(line: string): string | undefined {
	const date = parseDueDate(line);
	const time = parseDueTime(line);

	if (date && time) {
		return `${date}T${time}:00`;
	}

	return undefined;
}

/**
 * Extract priority from task line.
 * Supports !!1-4 format and emoji shortcuts.
 * Returns Todoist priority (1-4, where 1 is highest), or undefined.
 */
export function parsePriority(line: string): number | undefined {
	// Try !!N format first (explicit priority)
	const explicitPattern = /!![1-4]/;
	const explicitMatch = line.match(explicitPattern);
	if (explicitMatch) {
		return parseInt(explicitMatch[0].substring(2), 10);
	}

	// Try emoji shortcuts
	// ⏫ = high (p2 in Todoist)
	// 🔼 = medium (p3 in Todoist)
	// 🔽 = low (p4 in Todoist)
	if (line.includes('⏫')) {
		return 2;
	}
	if (line.includes('🔼')) {
		return 3;
	}
	if (line.includes('🔽')) {
		return 4;
	}

	return undefined;
}

/**
 * Extract duration from task line.
 * Supports formats: ⏳30min, ⏳1h, ⏳1h30m
 * Returns duration in minutes, or undefined if not found.
 */
export function parseDuration(line: string): number | undefined {
	// Try combined format first: ⏳1h30m
	const combinedPattern = /⏳\s*(\d+)h\s*(\d+)m/;
	const combinedMatch = line.match(combinedPattern);
	if (combinedMatch) {
		const hours = parseInt(combinedMatch[1], 10);
		const minutes = parseInt(combinedMatch[2], 10);
		return hours * 60 + minutes;
	}

	// Try hours only: ⏳2h
	const hoursPattern = /⏳\s*(\d+)h\b/;
	const hoursMatch = line.match(hoursPattern);
	if (hoursMatch) {
		return parseInt(hoursMatch[1], 10) * 60;
	}

	// Try minutes only: ⏳30min or ⏳30m
	const minutesPattern = /⏳\s*(\d+)(?:min|m)\b/;
	const minutesMatch = line.match(minutesPattern);
	if (minutesMatch) {
		return parseInt(minutesMatch[1], 10);
	}

	return undefined;
}

// ============================================================================
// BUILDING TASK LINES
// ============================================================================

/**
 * Build complete task line with enforced standard ordering.
 * Order: checkbox → content → user tags → priority → date → time → duration → #tdsync → TID
 */
export function buildTaskLine(
	data: TaskData,
	frontmatterLabels: string[]
): string {
	const parts: string[] = [];

	// 1. Checkbox
	const checkbox = data.completed ? '- [x]' : '- [ ]';
	parts.push(checkbox);

	// 2. Content
	parts.push(data.content);

	// 3. User labels (merge inline + frontmatter, deduplicate, filter tdsync)
	// tdsync is always added separately before TID, so exclude it from label list
	const allLabels = mergeLabelLists(data.labels, frontmatterLabels)
		.filter(l => l.toLowerCase() !== 'tdsync');
	if (allLabels.length > 0) {
		parts.push(allLabels.map(l => `#${l}`).join(' '));
	}

	// 4. Priority (if exists and NOT default)
	// Priority 1 is Todoist's default, so don't display it (like "no date" isn't shown)
	if (data.priority && data.priority !== 1) {
		parts.push(`!!${data.priority}`);
	}

	// 5. Due date (if exists)
	if (data.dueDate) {
		parts.push(`🗓️${data.dueDate}`);
	}

	// 6. Due time (if exists)
	if (data.dueTime) {
		parts.push(`⏰${data.dueTime}`);
	}

	// 7. Duration (if exists)
	if (data.duration) {
		parts.push(formatDuration(data.duration));
	}

	// 8. #tdsync tag (ALWAYS for synced tasks)
	parts.push('#tdsync');

	// 9. TID (if exists)
	if (data.tid) {
		parts.push(`%%[tid:: [${data.tid}](https://app.todoist.com/app/task/${data.tid})]%%`);
	}

	return parts.join(' ');
}

/**
 * Insert TID into existing task line (at the end).
 * Creates properly formatted TID comment with Todoist app link.
 */
export function insertTID(line: string, tid: string): string {
	// If line already has TID, replace it
	const tidPattern = /\s*%%\[tid::[^\]]*\][^\]]*\]%%\s*$/;
	if (tidPattern.test(line)) {
		return line.replace(
			tidPattern,
			` %%[tid:: [${tid}](https://app.todoist.com/app/task/${tid})]%%`
		);
	}

	// Otherwise append to end
	return `${line.trimEnd()} %%[tid:: [${tid}](https://app.todoist.com/app/task/${tid})]%%`;
}

/**
 * Update specific properties in existing task line.
 * Preserves unchanged properties and maintains standard ordering.
 */
export function updateTaskLine(
	oldLine: string,
	updates: Partial<TaskData>
): string {
	// Parse current state
	const current = parseTaskLine(oldLine);
	if (!current) {
		return oldLine; // Not a valid task, return unchanged
	}

	// Merge updates with current state
	const merged: TaskData = {
		...current,
		...updates
	};

	// Rebuild with standard ordering (no frontmatter labels for updates)
	return buildTaskLine(merged, []);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Merge two label lists, removing duplicates (case-insensitive).
 * Returns deduplicated list preserving order.
 */
function mergeLabelLists(labels1: string[], labels2: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const label of [...labels1, ...labels2]) {
		const lower = label.toLowerCase();
		if (!seen.has(lower)) {
			seen.add(lower);
			result.push(label);
		}
	}

	return result;
}

/**
 * Format duration in minutes to human-readable string.
 * Examples: 30 → ⏳30min, 60 → ⏳1h, 90 → ⏳1h30m
 */
function formatDuration(minutes: number): string {
	if (minutes < 60) {
		return `⏳${minutes}min`;
	}

	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;

	if (mins === 0) {
		return `⏳${hours}h`;
	}

	return `⏳${hours}h${mins}m`;
}
