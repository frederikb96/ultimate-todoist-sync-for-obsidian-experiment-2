// Todoist Sync API v9 Client
// Implements incremental sync with batch operations

import { v4 as uuidv4 } from 'uuid';
import { Notice } from 'obsidian';
import type { SyncResponse, TodoistTask, ApiCommand } from './types';

// Todoist Sync API v9 endpoint
const SYNC_API_URL = 'https://api.todoist.com/sync/v9/sync';

/**
 * Pull modified tasks from Todoist (incremental sync).
 * Uses sync_token to get only changes since last sync.
 *
 * @param apiToken - Todoist API token
 * @param syncToken - Last sync token (use "*" for full sync)
 * @returns SyncResponse with modified tasks and new sync_token
 */
export async function syncPull(
	apiToken: string,
	syncToken: string
): Promise<SyncResponse> {
	try {
		const response = await todoistSyncRequest(apiToken, {
			sync_token: syncToken,
			resource_types: JSON.stringify(['items'])
		});

		return {
			sync_token: response.sync_token,
			full_sync: response.full_sync || false,
			items: response.items || []
		};
	} catch (error) {
		// If sync token corrupted, fallback to full sync
		if (error instanceof Error && error.message.includes('Invalid sync token')) {
			console.warn('Sync token corrupted, falling back to full sync');
			new Notice('Sync token expired, performing full sync...');

			const response = await todoistSyncRequest(apiToken, {
				sync_token: '*',
				resource_types: JSON.stringify(['items'])
			});

			return {
				sync_token: response.sync_token,
				full_sync: true,
				items: response.items || []
			};
		}

		throw error;
	}
}

/**
 * Batch create multiple tasks.
 * Returns temp_id_mapping for matching with our data.
 *
 * @param apiToken - Todoist API token
 * @param tasks - Array of tasks to create
 * @returns Response with temp_id_mapping and new sync_token
 */
export async function syncBatchCreate(
	apiToken: string,
	tasks: Array<{
		temp_id: string;
		content: string;
		labels: string[];
		project_id?: string;
		due_date?: string;
		due_datetime?: string;
		priority?: number;
		duration?: number;
	}>
): Promise<{
	sync_token: string;
	temp_id_mapping: { [temp_id: string]: string };
	sync_status: { [uuid: string]: string };
}> {
	if (tasks.length === 0) {
		throw new Error('No tasks to create');
	}

	if (tasks.length > 100) {
		throw new Error('Cannot create more than 100 tasks in single batch');
	}

	// Build commands array with item_add
	const commands: ApiCommand[] = tasks.map(task => {
		const args: ApiCommand['args'] = {
			content: task.content,
			labels: task.labels
		};

		if (task.project_id) {
			args.project_id = task.project_id;
		}

		// Due date handling (k-note lines 1382-1510)
		if (task.due_datetime) {
			args.due = { datetime: task.due_datetime };
		} else if (task.due_date) {
			args.due = { date: task.due_date };
		}

		if (task.priority) {
			args.priority = task.priority;
		}

		if (task.duration) {
			args.duration = {
				amount: task.duration,
				unit: 'minute'
			};
		}

		return {
			type: 'item_add',
			temp_id: task.temp_id,
			uuid: uuidv4(),
			args
		};
	});

	const response = await todoistSyncRequest(apiToken, {
		commands: JSON.stringify(commands),
		resource_types: JSON.stringify(['items'])
	});

	return {
		sync_token: response.sync_token,
		temp_id_mapping: response.temp_id_mapping || {},
		sync_status: response.sync_status || {}
	};
}

/**
 * Batch update multiple tasks.
 *
 * @param apiToken - Todoist API token
 * @param updates - Array of task updates
 * @returns SyncResponse with new sync_token
 */
export async function syncBatchUpdate(
	apiToken: string,
	updates: Array<{
		id: string;
		content?: string;
		is_completed?: boolean;
		labels?: string[];
		due_date?: string;
		due_datetime?: string;
		priority?: number;
		duration?: number;
	}>
): Promise<SyncResponse> {
	if (updates.length === 0) {
		throw new Error('No tasks to update');
	}

	if (updates.length > 100) {
		throw new Error('Cannot update more than 100 tasks in single batch');
	}

	// Build commands array with item_update
	const commands: ApiCommand[] = updates.map(update => {
		const args: ApiCommand['args'] = {
			id: update.id
		};

		if (update.content !== undefined) {
			args.content = update.content;
		}

		if (update.is_completed !== undefined) {
			args.is_completed = update.is_completed;
		}

		if (update.labels !== undefined) {
			args.labels = update.labels;
		}

		// Due date handling
		if (update.due_datetime) {
			args.due = { datetime: update.due_datetime };
		} else if (update.due_date) {
			args.due = { date: update.due_date };
		}

		if (update.priority !== undefined) {
			args.priority = update.priority;
		}

		if (update.duration !== undefined) {
			args.duration = {
				amount: update.duration,
				unit: 'minute'
			};
		}

		return {
			type: 'item_update',
			uuid: uuidv4(),
			args
		};
	});

	const response = await todoistSyncRequest(apiToken, {
		commands: JSON.stringify(commands),
		resource_types: JSON.stringify(['items'])
	});

	return {
		sync_token: response.sync_token,
		full_sync: false,
		items: response.items || []
	};
}

/**
 * Batch delete multiple tasks.
 *
 * @param apiToken - Todoist API token
 * @param taskIds - Array of task IDs to delete
 * @returns SyncResponse with new sync_token
 */
export async function syncBatchDelete(
	apiToken: string,
	taskIds: string[]
): Promise<SyncResponse> {
	if (taskIds.length === 0) {
		throw new Error('No tasks to delete');
	}

	if (taskIds.length > 100) {
		throw new Error('Cannot delete more than 100 tasks in single batch');
	}

	// Build commands array with item_delete
	const commands: ApiCommand[] = taskIds.map(id => ({
		type: 'item_delete',
		uuid: uuidv4(),
		args: { id }
	}));

	const response = await todoistSyncRequest(apiToken, {
		commands: JSON.stringify(commands),
		resource_types: JSON.stringify(['items'])
	});

	return {
		sync_token: response.sync_token,
		full_sync: false,
		items: []
	};
}

/**
 * Test API connection and get user info.
 * Used for "Test Connection" button in settings.
 *
 * @param apiToken - Todoist API token to test
 * @returns Success status with user data or error message
 */
export async function testConnection(
	apiToken: string
): Promise<{
	success: boolean;
	userData?: {
		email: string;
		full_name: string;
		lang: string;
		tz_info: { timezone: string; gmt_string: string };
	};
	error?: string;
}> {
	try {
		// Simple sync with "*" token to validate
		const response = await todoistSyncRequest(apiToken, {
			sync_token: '*',
			resource_types: JSON.stringify(['user'])
		});

		// Extract user data from response
		if (response.user) {
			return {
				success: true,
				userData: {
					email: response.user.email,
					full_name: response.user.full_name,
					lang: response.user.lang,
					tz_info: {
						timezone: response.user.tz_info?.timezone || 'UTC',
						gmt_string: response.user.tz_info?.gmt_string || '+00:00'
					}
				}
			};
		}

		return {
			success: false,
			error: 'No user data in response'
		};
	} catch (error) {
		console.error('Todoist API connection test failed:', error);

		return {
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error'
		};
	}
}

/**
 * Internal helper: make Sync API request with error handling.
 *
 * @param apiToken - Todoist API token
 * @param body - Request body parameters
 * @returns API response data
 */
async function todoistSyncRequest(
	apiToken: string,
	body: {
		sync_token?: string;
		resource_types?: string;
		commands?: string;
	}
): Promise<any> {
	const maxRetries = 3;
	let retryDelay = 5000; // Start with 5s

	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			// Build URLSearchParams for form-encoded body
			const params = new URLSearchParams();

			if (body.sync_token) {
				params.append('sync_token', body.sync_token);
			}

			if (body.resource_types) {
				params.append('resource_types', body.resource_types);
			}

			if (body.commands) {
				params.append('commands', body.commands);
			}

			// Make request using native fetch
			const response = await fetch(SYNC_API_URL, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${apiToken}`,
					'Content-Type': 'application/x-www-form-urlencoded'
				},
				body: params.toString()
			});

			// Handle rate limiting (429)
			if (response.status === 429) {
				if (attempt < maxRetries - 1) {
					console.warn(`Rate limited, retrying in ${retryDelay}ms...`);
					new Notice(`Rate limited by Todoist, waiting ${retryDelay / 1000}s...`);

					await sleep(retryDelay);
					retryDelay = Math.min(retryDelay * 2, 60000); // Max 60s
					continue; // Retry
				} else {
					throw new Error('Rate limit exceeded, max retries reached');
				}
			}

			// Handle other HTTP errors
			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Todoist API error (${response.status}): ${errorText}`);
			}

			// Parse JSON response
			const data = await response.json();

			// Check for API-level errors
			if (data.error) {
				throw new Error(`Todoist API error: ${data.error}`);
			}

			return data;

		} catch (error) {
			// Network error or other issue
			if (attempt < maxRetries - 1) {
				console.warn(`Network error, retrying in ${retryDelay}ms...`, error);
				await sleep(retryDelay);
				retryDelay = Math.min(retryDelay * 2, 60000); // Max 60s
				continue; // Retry
			}

			// Max retries reached
			console.error('Todoist API request failed:', error);
			new Notice('Todoist API error - check console for details');
			throw error;
		}
	}

	// Should never reach here
	throw new Error('Unexpected error in todoistSyncRequest');
}

/**
 * Sleep helper for rate limiting backoff.
 */
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
