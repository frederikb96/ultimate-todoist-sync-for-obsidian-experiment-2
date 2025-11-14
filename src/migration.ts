// Migration - One-time import of existing tasks from Obsidian to DB
// Scans files with frontmatter, imports tasks that already have Todoist IDs

import { TFile, Vault, MetadataCache, Workspace, MarkdownView } from 'obsidian';
import { Database } from './database';
import { SyncSettings } from './types';
import { getModifiedFiles } from './syncEngine';
import { parseTaskLine } from './taskParser';

/**
 * Result of migration operation.
 */
export interface MigrationResult {
	success: boolean;
	taskCount: number;
	error?: string;
}

/**
 * Run migration to import existing tasks with TIDs into database.
 *
 * Process:
 * 1. Validate DB is empty (error if not)
 * 2. Scan all files with frontmatter
 * 3. Parse tasks that have TIDs
 * 4. Check for duplicate TIDs (error if found)
 * 5. Add tasks directly to DB (NOT pending_changes)
 * 6. Set syncToken="*" to force full sync
 *
 * After migration, user should trigger sync to pull API changes.
 * API will overwrite local if conflicts exist (desired behavior).
 *
 * @param vault - Obsidian vault
 * @param metadataCache - Metadata cache
 * @param workspace - Workspace (for active file detection)
 * @param db - Database instance
 * @param settings - Plugin settings
 * @returns Migration result with success/error/taskCount
 */
export async function runMigration(
	vault: Vault,
	metadataCache: MetadataCache,
	workspace: Workspace,
	db: Database,
	settings: SyncSettings
): Promise<MigrationResult> {
	console.log('Starting migration...');

	try {
		// Step 1: Validate DB is empty
		const existingTaskCount = Object.keys(settings.tasks).length;
		if (existingTaskCount > 0) {
			const error = `Database not empty! Found ${existingTaskCount} existing tasks.\n\nMigration requires an empty database. Please clear the database first or contact support.`;
			console.error('Migration failed: DB not empty');
			return { success: false, taskCount: 0, error };
		}

		// Step 2: Get all files with frontmatter (lastSync=0 gets ALL files)
		const files = getModifiedFiles(vault, metadataCache, 0);
		console.log(`Found ${files.length} files with todoist-sync frontmatter`);

		if (files.length === 0) {
			const error = 'No files with "todoist-sync: true" frontmatter found.\n\nAdd "todoist-sync: true" to your note frontmatter to enable sync.';
			console.warn('Migration aborted: No files with frontmatter');
			return { success: false, taskCount: 0, error };
		}

		// Step 3: Track TIDs to detect duplicates
		const tidToFile = new Map<string, string>();
		const migrationTime = Date.now();
		let taskCount = 0;

		// Step 4: Process each file sequentially
		for (const file of files) {
			// Detect if active file
			const activeFile = workspace.getActiveFile();
			const isActive = activeFile?.path === file.path;
			const activeView = isActive ? workspace.getActiveViewOfType(MarkdownView) : null;
			const editor = activeView?.editor || null;

			// Read content (editor if active, vault if background)
			const content = editor ? editor.getValue() : await vault.cachedRead(file);
			const lines = content.split('\n');

			console.log(`Processing file: ${file.path} (${lines.length} lines)`);

			// Parse each line for tasks with TIDs
			for (const line of lines) {
				const taskData = parseTaskLine(line);

				// Skip non-tasks or tasks without TID
				if (!taskData || !taskData.tid) {
					continue;
				}

				const tid = taskData.tid;

				// Check for duplicate TID
				if (tidToFile.has(tid)) {
					const error = `Duplicate Todoist ID found: ${tid}\n\nFiles:\n• ${tidToFile.get(tid)}\n• ${file.path}\n\nPlease fix duplicates and try again.`;
					console.error(`Migration aborted: Duplicate TID ${tid}`);
					return { success: false, taskCount: 0, error };
				}

				// Track this TID
				tidToFile.set(tid, file.path);

				// Add task directly to DB (NOT pending_changes)
				db.setTask(tid, {
					tid,
					filepath: file.path,
					content: taskData.content,
					completed: taskData.completed,
					labels: taskData.labels,
					dueDate: taskData.dueDate,
					dueTime: taskData.dueTime,
					dueDatetime: taskData.dueDatetime,
					priority: taskData.priority,
					duration: taskData.duration,
					lastSyncedAt: migrationTime,
					pending_changes: [] // Empty - no pending changes yet!
				});

				taskCount++;
			}
		}

		// Step 5: Set syncToken to "*" to force full sync on next run
		// This ensures tasks deleted on Todoist are detected
		settings.syncToken = '*';

		console.log(`Migration complete: ${taskCount} tasks imported`);
		return { success: true, taskCount };

	} catch (error) {
		console.error('Migration failed with exception:', error);
		const errorMsg = error instanceof Error ? error.message : 'Unknown error occurred';
		return { success: false, taskCount: 0, error: `Migration failed: ${errorMsg}` };
	}
}
