// TypeScript interfaces for Todoist Sync Plugin 2.0

// Plugin settings stored in data.json
export interface SyncSettings {
	// API & Authentication
	todoistAPIToken: string;
	apiInitialized: boolean;

	// Scheduled Sync
	enableScheduledSync: boolean;  // default: false (DISABLED)
	syncInterval: number;           // default: 60 seconds, min: 20

	// Default Project
	defaultProjectId: string;
	defaultProjectName: string;

	// Projects cache (fetched from API)
	projects: Array<{
		id: string;
		name: string;
		inbox_project?: boolean;
		is_archived: boolean;
		is_deleted: boolean;
		child_order: number;
	}>;

	// User Data (from Todoist API)
	userData: {
		email: string;
		full_name: string;
		lang: string;
		tz_info: {
			timezone: string;
			gmt_string: string;
		};
	};

	// Conflict Resolution
	conflictResolutionWindow: number;  // default: +60 seconds
	// Positive: API wins within window
	// Negative: Local wins within window

	// Internal State
	syncToken: string;  // Todoist Sync API token (start with "*" for full sync)
	lastSync: number;   // Last sync timestamp (milliseconds)
	tasks: { [tid: string]: TaskInDB };  // Task database (TID is primary key)
}

// Task data stored in DB
export interface TaskInDB {
	tid: string;       // Todoist task ID (PRIMARY KEY)
	filepath: string;  // Current file path

	// Full task state (everything we sync)
	content: string;        // Task content text
	completed: boolean;     // Checkbox state
	dueDate?: string;       // Due date (YYYY-MM-DD)
	dueTime?: string;       // Due time (HH:MM)
	dueDatetime?: string;   // Combined datetime
	priority?: number;      // Priority (1-4, Todoist format)
	duration?: number;      // Duration in minutes
	labels: string[];       // All labels including tdsync

	// Sync metadata
	lastSyncedAt: number;  // Per-task sync timestamp

	// Pending changes for conflict resolution
	pending_changes: Array<{
		source: 'api' | 'local';
		timestamp: number;
		changes: {
			deleted?: boolean;
			completed?: boolean;
			content?: string;
			dueDate?: string;
			dueTime?: string;
			dueDatetime?: string;
			priority?: number;
			duration?: number;
			labels?: string[];
		};
	}>;
}

// Task data for parsing (simpler structure)
export interface TaskData {
	content: string;
	completed: boolean;
	labels: string[];
	dueDate?: string;
	dueTime?: string;
	dueDatetime?: string;
	priority?: number;
	duration?: number;
	tid?: string;  // if exists
}

// Todoist Sync API response
export interface SyncResponse {
	sync_token: string;
	full_sync: boolean;
	items: TodoistTask[];
	temp_id_mapping?: { [temp_id: string]: string };
	sync_status?: { [uuid: string]: string };
}

// Todoist task from API
export interface TodoistTask {
	id: string;
	content: string;
	checked: boolean;  // Completion status (API field name is "checked" not "is_completed")
	is_deleted: boolean;  // Whether task is marked as deleted
	updated_at: string;  // Last modification timestamp (RFC3339 format in UTC)
	due?: {
		date: string;
		datetime?: string;
	};
	priority: number;
	labels: string[];
	project_id: string;
	duration?: {
		amount: number;
		unit: string;
	};
}

// API command for batch operations
export interface ApiCommand {
	type: 'item_add' | 'item_update' | 'item_delete';
	temp_id?: string;
	uuid: string;
	args: {
		id?: string;
		content?: string;
		checked?: boolean;  // API field name is "checked" not "is_completed"
		labels?: string[];
		project_id?: string;
		due?: { date?: string; datetime?: string };
		priority?: number;
		duration?: { amount: number; unit: string };
	};
}
