// Conflict Resolver - Conflict resolution logic for sync conflicts
// Applies timestamp-based resolution with configurable window

import { TaskInDB, SyncSettings } from './types';

/**
 * Resolve conflicts for a task with pending changes.
 * Applies conflict resolution rules based on timestamps and window setting.
 *
 * @param task - Task with pending changes to resolve
 * @param settings - Plugin settings (contains conflict resolution window)
 * @returns Resolved change (winning source and changes), or null if no conflicts
 */
export function resolveConflicts(
	task: TaskInDB,
	settings: SyncSettings
): { source: 'api' | 'local'; changes: any } | null {
	if (task.pending_changes.length === 0) {
		return null;  // No conflicts
	}

	// If only one source, use that change
	if (task.pending_changes.length === 1) {
		const change = task.pending_changes[0];
		console.log(`Single change from ${change.source}, no conflict`);
		return { source: change.source, changes: change.changes };
	}

	// Multiple changes - find API and local changes
	const apiChanges = task.pending_changes.filter(c => c.source === 'api');
	const localChanges = task.pending_changes.filter(c => c.source === 'local');

	// If only one source (multiple changes from same source), use latest
	if (apiChanges.length === 0 && localChanges.length > 0) {
		// Only local changes
		const latest = localChanges.reduce((a, b) =>
			a.timestamp > b.timestamp ? a : b
		);
		console.log(`Multiple local changes, using latest`);
		return { source: 'local', changes: latest.changes };
	}

	if (localChanges.length === 0 && apiChanges.length > 0) {
		// Only API changes
		const latest = apiChanges.reduce((a, b) =>
			a.timestamp > b.timestamp ? a : b
		);
		console.log(`Multiple API changes, using latest`);
		return { source: 'api', changes: latest.changes };
	}

	// CONFLICT: Both API and local changes exist
	// Get latest from each source
	const latestApi = apiChanges.reduce((a, b) =>
		a.timestamp > b.timestamp ? a : b
	);
	const latestLocal = localChanges.reduce((a, b) =>
		a.timestamp > b.timestamp ? a : b
	);

	console.log(`Conflict detected for task ${task.tid}:`, {
		apiTimestamp: new Date(latestApi.timestamp),
		localTimestamp: new Date(latestLocal.timestamp),
		window: settings.conflictResolutionWindow
	});

	// Compare timestamps with conflict window
	const winner = compareTimestamps(
		latestLocal.timestamp,
		latestApi.timestamp,
		settings.conflictResolutionWindow
	);

	if (winner === 'api') {
		console.log(`API wins conflict (timestamp: ${new Date(latestApi.timestamp)})`);
		return { source: 'api', changes: latestApi.changes };
	} else {
		console.log(`Local wins conflict (timestamp: ${new Date(latestLocal.timestamp)})`);
		return { source: 'local', changes: latestLocal.changes };
	}
}

/**
 * Compare timestamps and apply conflict resolution window.
 * Window rules:
 * - Positive window (+N): API wins if timestamps within N seconds
 * - Negative window (-N): Local wins if timestamps within N seconds
 * - If outside window: newest timestamp wins
 *
 * @param localTime - Local change timestamp (milliseconds)
 * @param apiTime - API change timestamp (milliseconds)
 * @param window - Conflict resolution window (seconds, can be negative)
 * @returns Winner ('local' or 'api')
 */
export function compareTimestamps(
	localTime: number,
	apiTime: number,
	window: number
): 'local' | 'api' {
	// Calculate time difference in seconds
	const diffSeconds = Math.abs(localTime - apiTime) / 1000;

	// Window in seconds (convert to absolute value for comparison)
	const windowSeconds = Math.abs(window);

	// Check if within window
	if (diffSeconds <= windowSeconds) {
		// Within window - apply window rule
		if (window > 0) {
			// Positive window: API wins
			console.log(`Within window (${windowSeconds}s), API wins (positive window)`);
			return 'api';
		} else {
			// Negative window: Local wins
			console.log(`Within window (${windowSeconds}s), Local wins (negative window)`);
			return 'local';
		}
	}

	// Outside window - newest timestamp wins
	if (localTime > apiTime) {
		console.log(`Outside window, Local wins (newer timestamp)`);
		return 'local';
	} else {
		console.log(`Outside window, API wins (newer timestamp)`);
		return 'api';
	}
}
