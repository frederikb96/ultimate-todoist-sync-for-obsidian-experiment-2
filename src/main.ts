import { Plugin, Notice } from 'obsidian';
import { SyncSettings } from './types';
import { DEFAULT_SETTINGS, Database } from './database';
import { TodoistSettingTab } from './settings';
import { runSync } from './syncEngine';
import { testConnection } from './todoistAPI';

export default class TodoistSyncPlugin extends Plugin {
	settings: SyncSettings;
	db: Database;
	syncIntervalId: number | null = null;
	isSyncInProgress = false;

	async onload() {
		console.log('Todoist Sync 2.0 - Loading');

		// Load settings from data.json
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.db = new Database(this.settings);

		// Add settings tab
		this.addSettingTab(new TodoistSettingTab(this.app, this));

		// Register commands
		this.registerCommands();

		// Start scheduled sync if enabled
		if (this.settings.enableScheduledSync) {
			this.startScheduledSync();
		}

		console.log('Todoist Sync 2.0 - Loaded');
	}

	async onunload() {
		// Stop scheduled sync
		this.stopScheduledSync();

		// Save settings
		await this.saveSettings();

		console.log('Todoist Sync 2.0 - Unloaded');
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
	 * Skips active file to avoid interfering with user edits.
	 * Runs silently in background - no notices on success, only on error.
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

		console.log('Starting scheduled sync (skipping active file)...');
		this.isSyncInProgress = true;

		try {
			// skipActiveFile = true for scheduled sync
			await runSync(
				this.app.vault,
				this.app.metadataCache,
				this.db,
				this.settings,
				true,  // Skip active file
				this
			);

			console.log('Scheduled sync completed successfully');
			// No notice for scheduled sync (background operation)

		} catch (error) {
			console.error('Scheduled sync failed:', error);
			// Show notice only on error (user should know if background sync failing)
			new Notice(`Background sync error: ${error instanceof Error ? error.message : 'Unknown error'}`);
		} finally {
			this.isSyncInProgress = false;
		}
	}

	/**
	 * Manual sync (called by user command).
	 * Processes ALL files including active file.
	 * Shows notices for feedback.
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
			// skipActiveFile = false for manual sync (process active file too!)
			await runSync(
				this.app.vault,
				this.app.metadataCache,
				this.db,
				this.settings,
				false,  // Process active file
				this
			);

			new Notice('Sync completed successfully!');
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

			if (result.success && result.userData) {
				// Update settings with user data
				this.settings.userData = result.userData;
				this.settings.apiInitialized = true;
				await this.saveSettings();

				new Notice(`Connected as ${result.userData.full_name} (${result.userData.email})`);
				console.log('API connection successful:', result.userData);
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
