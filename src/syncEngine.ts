// Sync Engine - Main sync coordinator
// Orchestrates the sync process: pull from API, process files, save DB

import { TFile, Vault, MetadataCache, Plugin, Notice } from 'obsidian';
import { Database } from './database';
import { SyncSettings } from './types';
import { nextFrame, sleep } from './utils';
import { syncPull } from './todoistAPI';
import { processFile } from './syncProcessor';

/**
 * Main sync entry point.
 * Coordinates the entire sync process: pull from API, process files, save DB.
 *
 * @param vault - Obsidian vault
 * @param metadataCache - Obsidian metadata cache
 * @param db - Database instance
 * @param settings - Plugin settings
 * @param skipActiveFile - If true, skip active file (for scheduled sync)
 * @param plugin - Plugin instance (for saving data)
 */
export async function runSync(
	vault: Vault,
	metadataCache: MetadataCache,
	db: Database,
	settings: SyncSettings,
	skipActiveFile: boolean,
	plugin: Plugin
): Promise<void> {
	console.log('Starting sync...', { skipActiveFile, lastSync: new Date(settings.lastSync) });

	try {
		// Get active file path if skipping
		const activeFilePath = skipActiveFile
			? plugin.app.workspace.getActiveFile()?.path
			: undefined;

		// Step 1: Get modified files (frontmatter filter + mtime check)
		const modifiedFiles = getModifiedFiles(
			vault,
			metadataCache,
			settings.lastSync,
			activeFilePath
		);
		console.log(`Found ${modifiedFiles.length} modified files to process`);

		if (modifiedFiles.length === 0) {
			console.log('No modified files, checking API for changes...');
		}

		// Step 2: Pull from Todoist API (incremental sync)
		await pullFromTodoist(db, settings);

		// Step 3: Process files sequentially with yielding
		// CRITICAL: Sequential processing required for move detection!
		if (modifiedFiles.length > 0) {
			await processFilesSequentially(
				modifiedFiles,
				vault,
				metadataCache,
				db,
				settings
			);
		}

		// Step 4: Update last sync timestamp
		settings.lastSync = Date.now();

		// Step 5: Save database once at end
		await saveDatabase(plugin, settings);

		console.log('Sync completed successfully');
		new Notice(`Sync completed: ${modifiedFiles.length} files processed`);

	} catch (error) {
		console.error('Sync failed:', error);
		new Notice(`Sync error: ${error instanceof Error ? error.message : 'Unknown error'}`);
		throw error;
	}
}

/**
 * Get list of modified files to process.
 * Filters by:
 * 1. todoist-sync: true frontmatter (via MetadataCache - instant!)
 * 2. file.stat.mtime > lastSync (filesystem modification time)
 * 3. Skip active file if provided
 *
 * @param vault - Obsidian vault
 * @param metadataCache - Obsidian metadata cache
 * @param lastSync - Last sync timestamp (milliseconds)
 * @param activeFilePath - Path of active file to skip (if provided)
 * @returns Array of files to process
 */
export function getModifiedFiles(
	vault: Vault,
	metadataCache: MetadataCache,
	lastSync: number,
	activeFilePath?: string
): TFile[] {

	// Get all markdown files
	const allFiles = vault.getMarkdownFiles();

	// Filter by frontmatter (MetadataCache - instant!)
	const syncEnabledFiles = allFiles.filter(file => {
		const cache = metadataCache.getFileCache(file);
		return cache?.frontmatter?.['todoist-sync'] === true;
	});

	// Filter by modification time AND skip active file
	const modifiedFiles = syncEnabledFiles.filter(file => {
		// Skip active file if requested
		if (activeFilePath && file.path === activeFilePath) {
			console.log('Skipping active file:', file.path);
			return false;
		}

		// Check if modified since last sync
		return file.stat.mtime > lastSync;
	});

	return modifiedFiles;
}

/**
 * Pull modified tasks from Todoist API (incremental sync).
 * Updates pending_changes for tasks that exist in our DB.
 *
 * @param db - Database instance
 * @param settings - Plugin settings (contains syncToken and API token)
 */
export async function pullFromTodoist(
	db: Database,
	settings: SyncSettings
): Promise<void> {
	console.log('Pulling from Todoist API...', { syncToken: settings.syncToken });

	try {
		// Call Sync API with current sync_token
		const response = await syncPull(settings.todoistAPIToken, settings.syncToken);

		console.log(`Received ${response.items.length} modified tasks from API`, {
			fullSync: response.full_sync
		});

		// Update sync token for next sync
		settings.syncToken = response.sync_token;

		// Process each modified task from API
		for (const apiTask of response.items) {
			// Filter by TID (NOT label!) - k-note lines 2447-2471
			// Check if this task exists in our DB
			const dbTask = db.getTask(apiTask.id);

			if (dbTask) {
				// Task exists in DB - add pending change from API
				dbTask.pending_changes.push({
					source: 'api',
					timestamp: Date.now(),
					changes: {
						content: apiTask.content,
						completed: apiTask.checked,  // API field is "checked" not "is_completed"
						labels: apiTask.labels,
						dueDate: apiTask.due?.date,
						dueDatetime: apiTask.due?.datetime,
						priority: apiTask.priority,
						duration: apiTask.duration?.amount
					}
				});

				console.log(`Task ${apiTask.id} has API changes`, {
					content: apiTask.content
				});
			} else {
				// Task NOT in our DB - skip with warning
				// Only warn if it has tdsync label (should be in DB)
				if (apiTask.labels?.includes('tdsync')) {
					console.warn(
						`Task ${apiTask.id} has tdsync label but not in DB - orphaned task?`,
						{ content: apiTask.content }
					);
				}
			}
		}

	} catch (error) {
		console.error('Failed to pull from Todoist:', error);
		throw new Error(`Todoist API pull failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}
}

/**
 * Process files sequentially with yielding.
 * CRITICAL: Sequential processing (NOT parallel) required for move detection!
 * Yields to UI between files to keep Obsidian responsive.
 *
 * @param files - Array of files to process
 * @param vault - Obsidian vault
 * @param metadataCache - Metadata cache
 * @param db - Database instance
 * @param settings - Plugin settings
 */
export async function processFilesSequentially(
	files: TFile[],
	vault: Vault,
	metadataCache: MetadataCache,
	db: Database,
	settings: SyncSettings
): Promise<void> {
	console.log(`Processing ${files.length} files sequentially...`);

	// Process ONE FILE AT A TIME (sequential, NOT parallel!)
	// This is CRITICAL for move detection - k-note lines 1689-1730
	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		console.log(`Processing file ${i + 1}/${files.length}: ${file.path}`);

		try {
			// Process this file completely before moving to next
			await processFile(file, vault, metadataCache, db, settings);

		} catch (error) {
			console.error(`Error processing file ${file.path}:`, error);
			new Notice(`Error processing ${file.basename}: ${error instanceof Error ? error.message : 'Unknown error'}`);
			// Continue with next file
		}

		// Yield to UI (keeps Obsidian responsive)
		// k-note lines 1999-2004
		await nextFrame();  // Wait for next animation frame
		await sleep(100);   // Extra throttling (configurable later)
	}

	console.log('Finished processing all files');
}

/**
 * Save database to disk.
 * Single save at end of sync (not during processing).
 *
 * @param plugin - Plugin instance
 * @param settings - Plugin settings to save
 */
export async function saveDatabase(
	plugin: Plugin,
	settings: SyncSettings
): Promise<void> {
	console.log('Saving database...', {
		taskCount: Object.keys(settings.tasks).length,
		syncToken: settings.syncToken
	});

	try {
		await plugin.saveData(settings);
		console.log('Database saved successfully');
	} catch (error) {
		console.error('Failed to save database:', error);
		throw new Error(`Database save failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
	}
}
