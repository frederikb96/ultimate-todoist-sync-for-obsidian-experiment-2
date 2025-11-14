import { SyncSettings, TaskInDB } from './types';

// Default settings for new installations
export const DEFAULT_SETTINGS: SyncSettings = {
	// API & Authentication
	todoistAPIToken: '',
	apiInitialized: false,

	// Scheduled Sync (DISABLED by default)
	enableScheduledSync: false,
	syncInterval: 60,  // 60 seconds

	// Default Project
	defaultProjectId: '',
	defaultProjectName: 'Inbox',

	// Projects cache
	projects: [],

	// User Data
	userData: {
		email: '',
		full_name: '',
		lang: 'en',
		tz_info: {
			timezone: 'UTC',
			gmt_string: '+00:00'
		}
	},

	// Conflict Resolution (API wins by default)
	conflictResolutionWindow: 60,  // +60 seconds

	// Migration & Initial Sync
	completedTasksLookbackDays: 90,  // 90 days (3 months, max API allows)

	// Internal State
	syncToken: '*',  // Full sync on first run
	lastSync: 0,
	tasks: {}
};

// Database class for task operations
export class Database {
	settings: SyncSettings;

	constructor(settings: SyncSettings) {
		this.settings = settings;
	}

	// Get task by TID
	getTask(tid: string): TaskInDB | undefined {
		return this.settings.tasks[tid];
	}

	// Set/update task
	setTask(tid: string, task: TaskInDB): void {
		this.settings.tasks[tid] = task;
	}

	// Delete task
	deleteTask(tid: string): void {
		delete this.settings.tasks[tid];
	}

	// Get all tasks for a file
	getTasksForFile(filepath: string): Array<[string, TaskInDB]> {
		return Object.entries(this.settings.tasks)
			.filter(([_, task]) => task.filepath === filepath);
	}

	// Find task by TID anywhere in vault
	findTask(tid: string): TaskInDB | undefined {
		return this.settings.tasks[tid];
	}

	// Clear all pending changes for a task
	clearPendingChanges(tid: string): void {
		const task = this.settings.tasks[tid];
		if (task) {
			task.pending_changes = [];
		}
	}

	// Get tasks modified since last sync (have pending changes)
	getModifiedTasks(): Array<[string, TaskInDB]> {
		return Object.entries(this.settings.tasks)
			.filter(([_, task]) => task.pending_changes.length > 0);
	}

	// Get all TIDs
	getAllTids(): string[] {
		return Object.keys(this.settings.tasks);
	}

	// Count total tasks
	getTotalTaskCount(): number {
		return Object.keys(this.settings.tasks).length;
	}
}
