import { Plugin, Notice } from 'obsidian';
import { SyncSettings } from './types';
import { DEFAULT_SETTINGS, Database } from './database';
import { TodoistSettingTab } from './settings';
import { runSync } from './syncEngine';
import { testConnection } from './todoistAPI';
import { runMigration } from './migration';

export default class TodoistSyncPlugin extends Plugin {
	settings: SyncSettings;
	db: Database;
	settingTab: TodoistSettingTab;
	syncIntervalId: number | null = null;
	isSyncInProgress = false;

	async onload() {
		console.log('Another Even Simpler Todoist Sync - Loading');

		// Load settings from data.json
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.db = new Database(this.settings);

		// Add settings tab and store reference
		this.settingTab = new TodoistSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Register commands
		this.registerCommands();

		// Start scheduled sync if enabled
		if (this.settings.enableScheduledSync) {
			this.startScheduledSync();
		}

		console.log('Another Even Simpler Todoist Sync - Loaded');
	}

	async onunload() {
		// Stop scheduled sync
		this.stopScheduledSync();

		// Save settings
		await this.saveSettings();

		console.log('Another Even Simpler Todoist Sync - Unloaded');
	}

	/**
	 * Register plugin commands.
	 * Commands can be assigned keyboard shortcuts by user in settings.
	 */
	registerCommands(): void {
		// Manual sync command (can assign keyboard shortcut)
		this.addCommand({
			id: 'manual-sync',
			name: 'Sync with Todoist (manual)',
			callback: () => this.manualSync()
		});

		// Test API connection command
		this.addCommand({
			id: 'test-connection',
			name: 'Test Todoist API connection',
			callback: () => this.testAPIConnection()
		});
	}

	/**
	 * Scheduled sync (called by interval timer).
	 * Processes ALL files including active file.
	 * Runs silently in background - no success notices, only error notices.
	 */
	async scheduledSync(): Promise<void> {
		// Guard: skip if sync already in progress
		if (this.isSyncInProgress) {
			console.log('Sync already in progress, skipping scheduled sync');
			return;
		}

		// Guard: skip if API not initialized
		if (!this.settings.apiInitialized || !this.settings.todoistAPIToken) {
			console.log('API not initialized, skipping scheduled sync');
			return;
		}

		console.log('Starting scheduled sync (background operation)...');
		this.isSyncInProgress = true;

		try {
			// showSuccessNotice = false for scheduled sync (silent background operation)
			await runSync(
				this.app.vault,
				this.app.metadataCache,
				this.app.workspace,
				this.db,
				this.settings,
				false,  // Don't show success notice
				this
			);

			console.log('Scheduled sync completed successfully');
			// No notice for scheduled sync (background operation)

		} catch (error) {
			console.error('Scheduled sync failed:', error);
			// Error notice ALWAYS shown (user should know if background sync failing)
			new Notice(`Background sync error: ${error instanceof Error ? error.message : 'Unknown error'}`);
		} finally {
			this.isSyncInProgress = false;
		}
	}

	/**
	 * Manual sync (called by user command).
	 * Processes ALL files including active file.
	 * Shows start notice and detailed success notice.
	 */
	async manualSync(): Promise<void> {
		// Guard: skip if sync already in progress
		if (this.isSyncInProgress) {
			new Notice('Sync already in progress...');
			return;
		}

		// Guard: check API configured
		if (!this.settings.apiInitialized || !this.settings.todoistAPIToken) {
			new Notice('Please configure Todoist API token in settings first');
			return;
		}

		new Notice('Starting sync with Todoist...');
		this.isSyncInProgress = true;

		try {
			// showSuccessNotice = true for manual sync (user gets detailed feedback)
			await runSync(
				this.app.vault,
				this.app.metadataCache,
				this.app.workspace,
				this.db,
				this.settings,
				true,  // Show success notice with details
				this
			);

			// Success notice shown by runSync with file counts
			console.log('Manual sync completed successfully');

		} catch (error) {
			console.error('Manual sync failed:', error);
			new Notice(`Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		} finally {
			this.isSyncInProgress = false;
		}
	}

	/**
	 * Test API connection and fetch user data.
	 * Called by "Test Connection" button in settings.
	 */
	async testAPIConnection(): Promise<void> {
		// Guard: check token exists
		if (!this.settings.todoistAPIToken) {
			new Notice('Please enter API token first');
			return;
		}

		new Notice('Testing Todoist API connection...');

		try {
			// Call test connection API
			const result = await testConnection(this.settings.todoistAPIToken);

			if (result.success && result.userData && result.projects) {
				// Update settings with user data
				this.settings.userData = result.userData;
				this.settings.projects = result.projects;
				this.settings.apiInitialized = true;

				// Set default project to Inbox
				const inbox = result.projects.find(p => p.inbox_project);
				if (inbox) {
					this.settings.defaultProjectId = inbox.id;
					this.settings.defaultProjectName = inbox.name;
				}

				await this.saveSettings();

				new Notice(`Connected as ${result.userData.full_name} (${result.userData.email})`);
				console.log('API connection successful:', {
					userData: result.userData,
					projects: result.projects.length
				});

				// Force settings UI refresh to enable Import button and show projects
				this.settingTab.display();
			} else {
				throw new Error(result.error || 'Unknown error');
			}

		} catch (error) {
			console.error('API connection failed:', error);
			new Notice(`Connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);

			// Mark as not initialized
			this.settings.apiInitialized = false;
			await this.saveSettings();
		}
	}

	/**
	 * Run migration to import existing tasks from Obsidian files.
	 * Called by "Import Tasks" button in settings.
	 */
	async runMigration(): Promise<void> {
		// Guard: check if sync in progress
		if (this.isSyncInProgress) {
			new Notice('Cannot run migration while sync is in progress. Please wait.');
			return;
		}

		// Guard: check API configured
		if (!this.settings.apiInitialized || !this.settings.todoistAPIToken) {
			new Notice('Please configure Todoist API token in settings first');
			return;
		}

		new Notice('Starting migration...');
		this.isSyncInProgress = true; // Prevent sync during migration

		try {
			// Call migration function
			const result = await runMigration(
				this.app.vault,
				this.app.metadataCache,
				this.app.workspace,
				this.db,
				this.settings
			);

			if (result.success) {
				// Save settings (persists syncToken="*" change)
				await this.saveSettings();

				// Show success message and indicate auto-sync starting
				new Notice(
					`Migration complete! ${result.taskCount} tasks imported.\n\nStarting automatic sync...`,
					8000 // Show for 8 seconds
				);
				console.log(`Migration successful: ${result.taskCount} tasks imported`);

				// Auto-trigger manual sync after migration
				// Use manual sync (skipActiveFile=false) to ensure complete reconciliation
				console.log('Auto-triggering sync after migration...');

				// Small delay to let user see migration complete notice
				setTimeout(async () => {
					await this.manualSync();
				}, 1000);
			} else {
				// Show error message
				new Notice(result.error || 'Migration failed', 15000);
				console.error('Migration failed:', result.error);
			}

		} catch (error) {
			console.error('Migration failed with exception:', error);
			new Notice(`Migration error: ${error instanceof Error ? error.message : 'Unknown error'}`);
		} finally {
			this.isSyncInProgress = false; // Always reset flag
		}
	}

	/**
	 * Start scheduled sync interval.
	 * Uses registerInterval for auto-cleanup on plugin unload.
	 */
	startScheduledSync(): void {
		// Guard: already running
		if (this.syncIntervalId !== null) {
			console.log('Scheduled sync already running');
			return;
		}

		const intervalMs = this.settings.syncInterval * 1000;
		console.log(`Starting scheduled sync every ${this.settings.syncInterval}s`);

		// Register interval using Obsidian's registerInterval for auto-cleanup
		this.syncIntervalId = this.registerInterval(
			window.setInterval(() => this.scheduledSync(), intervalMs)
		);
	}

	/**
	 * Stop scheduled sync interval.
	 */
	stopScheduledSync(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
			console.log('Stopped scheduled sync');
		}
	}

	/**
	 * Restart scheduled sync interval.
	 * Used when user changes sync interval in settings.
	 */
	restartScheduledSync(): void {
		this.stopScheduledSync();

		if (this.settings.enableScheduledSync) {
			this.startScheduledSync();
		}
	}

	/**
	 * Save settings to data.json.
	 */
	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
