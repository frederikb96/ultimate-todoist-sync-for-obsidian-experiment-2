// Sync Processor - Process single file with task detection and updates
// Handles new tasks, existing tasks, bidirectional checking, and conflict resolution

import { TFile, Vault, MetadataCache, Workspace, MarkdownView, Editor, Notice, EditorChange } from 'obsidian';
import { v4 as uuidv4 } from 'uuid';
import { Database } from './database';
import { SyncSettings, TaskData, TaskInDB } from './types';
import { isMarkdownTask, extractTID, nextFrame } from './utils';
import { parseTaskLine, parseTaskContent, buildTaskLine, insertTID } from './taskParser';
import { syncBatchCreate, syncBatchUpdate, syncBatchDelete } from './todoistAPI';
import { resolveConflicts } from './conflictResolver';

/**
 * Process a single file: parse tasks, detect changes, resolve conflicts, update.
 * Main file processor implementing the complete sync flow for one file.
 *
 * Uses Editor API for active files (preserves cursor, reads unflushed changes).
 * Uses Vault API for background files (standard atomic operations).
 *
 * @param file - File to process
 * @param vault - Obsidian vault
 * @param metadataCache - Metadata cache
 * @param workspace - Obsidian workspace (for active file detection)
 * @param db - Database instance
 * @param settings - Plugin settings
 */
export async function processFile(
	file: TFile,
	vault: Vault,
	metadataCache: MetadataCache,
	workspace: Workspace,
	db: Database,
	settings: SyncSettings
): Promise<void> {
	console.log(`Processing file: ${file.path}`);

	// Detect if this is the active file
	const activeFile = workspace.getActiveFile();
	const isActive = activeFile?.path === file.path;
	const activeView = isActive ? workspace.getActiveViewOfType(MarkdownView) : null;
	const editor = activeView?.editor || null;

	if (isActive && editor) {
		console.log('Processing ACTIVE file with Editor API');
	} else if (isActive) {
		console.log('Active file but no editor available, falling back to Vault API');
	} else {
		console.log('Processing background file with Vault API');
	}

	// Read file content
	// Use editor.getValue() for active file (includes unflushed changes)
	// Use vault.cachedRead() for background files
	const content = editor ? editor.getValue() : await vault.cachedRead(file);
	const lines = content.split('\n');

	// Get frontmatter labels (apply to ALL tasks in this file)
	const cache = metadataCache.getFileCache(file);
	const frontmatterLabels: string[] = cache?.frontmatter?.['todoist-labels'] || [];

	// Parse all markdown tasks in file (k-note lines 2261-2290)
	// Process ALL tasks if frontmatter has todoist-sync: true
	const allTasks: Array<{ lineNum: number; line: string; tid: string | null }> = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (isMarkdownTask(line)) {
			const tid = extractTID(line);
			allTasks.push({ lineNum: i, line, tid });
		}
	}

	console.log(`Found ${allTasks.length} tasks in file`);

	// Separate new vs existing tasks
	const newTasks = allTasks.filter(t => t.tid === null);
	const existingTasks = allTasks.filter(t => t.tid !== null);

	console.log(`New tasks: ${newTasks.length}, Existing tasks: ${existingTasks.length}`);

	// Bidirectional check: DB → File (detect moved/deleted tasks)
	// Do this FIRST, before any API calls, using already-extracted task list
	await bidirectionalCheck(file, existingTasks, vault, metadataCache, db);

	// Process new tasks (create on Todoist API, write TIDs back)
	if (newTasks.length > 0) {
		await processNewTasks(file, newTasks, vault, editor, db, settings, frontmatterLabels);
	}

	// Process existing tasks (detect changes, resolve conflicts, update)
	if (existingTasks.length > 0) {
		await processExistingTasks(file, existingTasks, vault, editor, db, settings);
	}

	console.log(`Finished processing file: ${file.path}`);
}

/**
 * Process new tasks: batch create on API, write TIDs back to file.
 * Uses full content match to find tasks after API creation.
 * k-note lines 2297-2357, 2640-2661
 *
 * @param file - File containing new tasks
 * @param newTasks - Array of new tasks (no TID)
 * @param vault - Obsidian vault
 * @param editor - Editor (if active file), null otherwise
 * @param db - Database instance
 * @param settings - Plugin settings
 * @param frontmatterLabels - Labels from file frontmatter
 */
async function processNewTasks(
	file: TFile,
	newTasks: Array<{ lineNum: number; line: string; tid: string | null }>,
	vault: Vault,
	editor: Editor | null,
	db: Database,
	settings: SyncSettings,
	frontmatterLabels: string[]
): Promise<void> {
	console.log(`Processing ${newTasks.length} new tasks...`);

	// Step 1: Build commands array with temp_id (preserve order!)
	const commands = newTasks.map((task, index) => {
		const taskData = parseTaskLine(task.line);
		if (!taskData) {
			console.error(`Failed to parse task line: ${task.line}`);
			return null;
		}

		return {
			temp_id: `new-${index}`,  // Preserve order!
			content: taskData.content,
			labels: [...new Set(['tdsync', ...frontmatterLabels, ...taskData.labels])],
			project_id: settings.defaultProjectId,
			due_date: taskData.dueDate,
			due_datetime: taskData.dueDatetime,
			priority: taskData.priority,
			duration: taskData.duration
		};
	}).filter(cmd => cmd !== null);

	if (commands.length === 0) {
		console.warn('No valid tasks to create');
		return;
	}

	// Step 2: Batch create on Todoist API
	try {
		const response = await syncBatchCreate(
			settings.todoistAPIToken,
			commands as any[]  // Type assertion (we filtered nulls)
		);

		console.log(`Created ${Object.keys(response.temp_id_mapping).length} tasks on Todoist`);

		// Update sync token
		settings.syncToken = response.sync_token;

		// Step 3: Write TIDs back to file
		// Use editor.processLines() for active files (preserves cursor)
		// Use vault.process() for background files (atomic)
		//
		// KNOWN LIMITATION: Content-based matching
		// If user has duplicate task content (two tasks with identical text),
		// only the first occurrence will receive a TID. The second task will
		// fail content match (first task now has TID) and be deleted from API.
		// This is an acceptable edge case - duplicate content is rare and
		// deduplication may even be desired behavior.
		if (editor) {
			// Active file: Use editor.processLines()
			console.log('Writing TIDs using Editor API (active file)');

			//  Create TID mapping for processLines
			const tidMapping = new Map<string, string>();
			for (let i = 0; i < newTasks.length; i++) {
				const tempId = `new-${i}`;
				const realTID = response.temp_id_mapping[tempId];
				if (realTID) {
					tidMapping.set(newTasks[i].line, realTID);
				}
			}

			// Track which tasks were successfully written
			const writtenTIDs = new Set<string>();

			editor.processLines<string | null>(
				// Phase 1: Identify lines that need TIDs
				(lineNum, lineText) => {
					const tid = tidMapping.get(lineText);
					if (tid && !writtenTIDs.has(tid)) {
						return tid;  // Return TID for this line
					}
					return null;
				},
				// Phase 2: Generate changes for matched lines
				(lineNum, lineText, tid) => {
					if (tid) {
						const taskData = parseTaskLine(lineText);
						if (taskData) {
							taskData.tid = tid;
							const newLine = buildTaskLine(taskData, frontmatterLabels);

							// Add to DB
							db.setTask(tid, {
								tid,
								filepath: file.path,
								content: taskData.content,
								completed: taskData.completed,
								dueDate: taskData.dueDate,
								dueTime: taskData.dueTime,
								dueDatetime: taskData.dueDatetime,
								priority: taskData.priority,
								duration: taskData.duration,
								labels: [...new Set(['tdsync', ...frontmatterLabels, ...taskData.labels])],
								lastSyncedAt: Date.now(),
								pending_changes: []
							});

							writtenTIDs.add(tid);

							// Return EditorChange if line changed
							if (newLine !== lineText) {
								return {
									from: { line: lineNum, ch: 0 },
									to: { line: lineNum, ch: lineText.length },
									text: newLine
								};
							}
						}
					}
					// No change needed
					return undefined;
				}
			);

			// Fallback: Check if any TIDs weren't written (ghost tasks)
			for (const [taskLine, tid] of tidMapping) {
				if (!writtenTIDs.has(tid)) {
					console.error(`Task not found during editor.processLines(): ${taskLine.substring(0, 50)}...`);
					new Notice(`Task disappeared during sync - deleting from Todoist`);
					syncBatchDelete(settings.todoistAPIToken, [tid])
						.catch(err => console.error('Failed to delete ghost task:', err));
				}
			}

		} else {
			// Background file: Use vault.process() (existing logic)
			console.log('Writing TIDs using Vault API (background file)');

			await vault.process(file, (currentContent) => {
				const currentLines = currentContent.split('\n');

				// Process in ORDER (handles duplicate content!)
				for (let i = 0; i < newTasks.length; i++) {
					const task = newTasks[i];
					const tempId = `new-${i}`;
					const realTID = response.temp_id_mapping[tempId];

					if (!realTID) {
						console.error(`No TID mapping for temp_id: ${tempId}`);
						continue;
					}

					// Find first occurrence of EXACT content (order matters!)
					let found = false;
					for (let lineIdx = 0; lineIdx < currentLines.length; lineIdx++) {
						const currentLine = currentLines[lineIdx];

						// Match by FULL content AND no TID yet
						if (currentLine === task.line && extractTID(currentLine) === null) {
							// Found it! Add TID and enforce ordering
							const taskData = parseTaskLine(currentLine);
							if (taskData) {
								taskData.tid = realTID;
								currentLines[lineIdx] = buildTaskLine(taskData, frontmatterLabels);

								// Add to DB
								db.setTask(realTID, {
									tid: realTID,
									filepath: file.path,
									content: taskData.content,
									completed: taskData.completed,
									dueDate: taskData.dueDate,
									dueTime: taskData.dueTime,
									dueDatetime: taskData.dueDatetime,
									priority: taskData.priority,
									duration: taskData.duration,
									labels: [...new Set(['tdsync', ...frontmatterLabels, ...taskData.labels])],
									lastSyncedAt: Date.now(),
									pending_changes: []
								});

								found = true;
								break;  // Move to next task
							}
						}
					}

					// FALLBACK: Content changed between read and write!
					// Delete from API to avoid ghost tasks
					if (!found) {
						console.error(`Task not found by full content match: ${task.line.substring(0, 50)}...`);
						new Notice(`Task disappeared during sync - deleting from Todoist`);

						// Delete from API immediately
						syncBatchDelete(settings.todoistAPIToken, [realTID])
							.catch(err => console.error('Failed to delete ghost task:', err));
					}
				}

				return currentLines.join('\n');
			});
		}

	} catch (error) {
		console.error('Failed to create new tasks:', error);
		new Notice(`Failed to create tasks: ${error instanceof Error ? error.message : 'Unknown error'}`);
		throw error;
	}
}

/**
 * Process existing tasks: detect changes, resolve conflicts, apply updates.
 * Implements bidirectional checking (File → DB).
 * k-note lines 2376-2432
 *
 * @param file - File containing existing tasks
 * @param existingTasks - Array of tasks with TIDs
 * @param vault - Obsidian vault
 * @param editor - Editor (if active file), null otherwise
 * @param db - Database instance
 * @param settings - Plugin settings
 */
async function processExistingTasks(
	file: TFile,
	existingTasks: Array<{ lineNum: number; line: string; tid: string | null }>,
	vault: Vault,
	editor: Editor | null,
	db: Database,
	settings: SyncSettings
): Promise<void> {
	console.log(`Processing ${existingTasks.length} existing tasks...`);

	// Direction 1: File → DB
	// Check each task in file, compare with DB state
	for (const task of existingTasks) {
		if (!task.tid) continue;  // Should not happen (filtered above)

		const dbTask = db.getTask(task.tid);

		if (!dbTask) {
			// Task has TID but NOT in DB - moved from different file or orphaned
			console.warn(`Task ${task.tid} not in DB, adding...`);

			const taskData = parseTaskLine(task.line);
			if (taskData) {
				db.setTask(task.tid, {
					tid: task.tid,
					filepath: file.path,
					content: taskData.content,
					completed: taskData.completed,
					dueDate: taskData.dueDate,
					dueTime: taskData.dueTime,
					dueDatetime: taskData.dueDatetime,
					priority: taskData.priority,
					duration: taskData.duration,
					labels: taskData.labels,
					lastSyncedAt: Date.now(),
					pending_changes: []
				});
			}
			continue;
		}

		// Task exists in DB - check if moved to this file
		if (dbTask.filepath !== file.path) {
			console.log(`Task ${task.tid} moved from ${dbTask.filepath} to ${file.path}`);
			dbTask.filepath = file.path;
		}

		// Compare content with DB state - detect local changes
		const currentTaskData = parseTaskLine(task.line);
		if (!currentTaskData) {
			console.warn(`Failed to parse task ${task.tid}`);
			continue;
		}

		// Check if content changed
		const contentChanged = currentTaskData.content !== dbTask.content;
		const completedChanged = currentTaskData.completed !== dbTask.completed;
		const dueDateChanged = currentTaskData.dueDate !== dbTask.dueDate;
		const priorityChanged = currentTaskData.priority !== dbTask.priority;
		const durationChanged = currentTaskData.duration !== dbTask.duration;

		if (contentChanged || completedChanged || dueDateChanged || priorityChanged || durationChanged) {
			// Local changes detected - add to pending_changes
			console.log(`Local changes detected for task ${task.tid}`);

			dbTask.pending_changes.push({
				source: 'local',
				timestamp: file.stat.mtime,  // Use file modification time
				changes: {
					content: currentTaskData.content,
					completed: currentTaskData.completed,
					dueDate: currentTaskData.dueDate,
					dueDatetime: currentTaskData.dueDatetime,
					priority: currentTaskData.priority,
					duration: currentTaskData.duration,
					labels: currentTaskData.labels
				}
			});
		}
	}

	// Now resolve conflicts and apply updates
	await resolveAndApplyUpdates(file, vault, editor, db, settings);
}

/**
 * Resolve conflicts and apply updates for all tasks with pending changes.
 * Batch updates to Todoist, then write back to Obsidian.
 *
 * @param file - File to update
 * @param vault - Obsidian vault
 * @param editor - Editor (if active file), null otherwise
 * @param db - Database instance
 * @param settings - Plugin settings
 */
async function resolveAndApplyUpdates(
	file: TFile,
	vault: Vault,
	editor: Editor | null,
	db: Database,
	settings: SyncSettings
): Promise<void> {
	// Get all tasks with pending changes
	const tasksToUpdate = db.getModifiedTasks();

	if (tasksToUpdate.length === 0) {
		return;  // Nothing to update
	}

	console.log(`Resolving conflicts for ${tasksToUpdate.length} tasks...`);

	// Resolve conflicts and collect updates
	const apiUpdates: Array<{
		id: string;
		content?: string;
		checked?: boolean;  // API field is "checked" not "is_completed"
		labels?: string[];
		due_date?: string;
		due_datetime?: string;
		priority?: number;
		duration?: number;
	}> = [];

	const fileUpdates: Array<{ tid: string; newContent: string }> = [];
	const apiDeletions: string[] = [];  // Task IDs to delete from Todoist
	const fileDeletions: string[] = [];  // Task IDs to delete from Obsidian

	for (const [tid, task] of tasksToUpdate) {
		// Resolve conflicts (returns winning change)
		const resolution = resolveConflicts(task, settings);

		if (!resolution) {
			console.log(`No conflicts for task ${tid}, clearing pending changes`);
			db.clearPendingChanges(tid);
			continue;
		}

		console.log(`Resolved conflict for task ${tid}: ${resolution.source} wins`);

		// HANDLE DELETIONS FIRST (delete always wins!)
		if (resolution.changes.deleted) {
			console.log(`Task ${tid} marked for deletion (source: ${resolution.source})`);

			if (resolution.source === 'local') {
				// Local deletion → delete from Todoist API
				apiDeletions.push(tid);
			} else {
				// API deletion → delete from Obsidian file
				fileDeletions.push(tid);
			}

			// Remove from DB immediately
			db.deleteTask(tid);
			continue;  // Skip normal update logic
		}

		if (resolution.source === 'local') {
			// Local wins - push to API
			apiUpdates.push({
				id: tid,
				content: resolution.changes.content,
				checked: resolution.changes.completed,  // API field is "checked"
				labels: resolution.changes.labels,
				due_date: resolution.changes.dueDate,
				due_datetime: resolution.changes.dueDatetime,
				priority: resolution.changes.priority,
				duration: resolution.changes.duration
			});

			// Update DB state with local changes
			task.content = resolution.changes.content || task.content;
			task.completed = resolution.changes.completed ?? task.completed;
			task.dueDate = resolution.changes.dueDate;
			task.dueDatetime = resolution.changes.dueDatetime;
			task.priority = resolution.changes.priority;
			task.duration = resolution.changes.duration;
			task.labels = resolution.changes.labels || task.labels;

		} else {
			// API wins - update file
			const updatedData: TaskData = {
				content: resolution.changes.content || task.content,
				completed: resolution.changes.completed ?? task.completed,
				labels: resolution.changes.labels || task.labels,
				dueDate: resolution.changes.dueDate,
				dueDatetime: resolution.changes.dueDatetime,
				priority: resolution.changes.priority,
				duration: resolution.changes.duration,
				tid: tid
			};

			fileUpdates.push({
				tid,
				newContent: buildTaskLine(updatedData, [])
			});

			// Update DB state with API changes
			task.content = updatedData.content;
			task.completed = updatedData.completed;
			task.dueDate = updatedData.dueDate;
			task.dueDatetime = updatedData.dueDatetime;
			task.priority = updatedData.priority;
			task.duration = updatedData.duration;
			task.labels = updatedData.labels;
		}

		// Clear pending changes and update timestamp
		task.pending_changes = [];
		task.lastSyncedAt = Date.now();
	}

	// Apply API updates (batch)
	if (apiUpdates.length > 0) {
		try {
			console.log(`Pushing ${apiUpdates.length} updates to Todoist...`);
			const response = await syncBatchUpdate(settings.todoistAPIToken, apiUpdates);
			settings.syncToken = response.sync_token;
			console.log('API updates successful');
		} catch (error) {
			console.error('Failed to push updates to API:', error);
			new Notice(`Failed to sync to Todoist: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	// Apply API deletions (batch)
	if (apiDeletions.length > 0) {
		try {
			console.log(`Deleting ${apiDeletions.length} tasks from Todoist...`);
			const response = await syncBatchDelete(settings.todoistAPIToken, apiDeletions);
			settings.syncToken = response.sync_token;
			console.log('API deletions successful');
		} catch (error) {
			console.error('Failed to delete from Todoist:', error);
			new Notice(`Failed to delete tasks from Todoist: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	// Apply file deletions (remove lines from Obsidian)
	if (fileDeletions.length > 0) {
		await deleteTasksFromFile(file, fileDeletions, editor, vault);
	}

	// Apply file updates
	// Use editor.processLines() for active files (preserves cursor)
	// Use vault.process() for background files (atomic)
	if (fileUpdates.length > 0) {
		if (editor) {
			// Active file: Use editor.processLines() for all updates atomically
			console.log(`Applying ${fileUpdates.length} file updates using Editor API (active file)`);

			// Create TID → content mapping
			const updateMapping = new Map<string, string>();
			for (const update of fileUpdates) {
				updateMapping.set(update.tid, update.newContent);
			}

			editor.processLines<string | null>(
				// Phase 1: Identify lines that need updates
				(lineNum, lineText) => {
					const tid = extractTID(lineText);
					if (tid && updateMapping.has(tid)) {
						return updateMapping.get(tid)!;
					}
					return null;
				},
				// Phase 2: Generate changes for matched lines
				(lineNum, lineText, newContent) => {
					if (newContent && newContent !== lineText) {
						return {
							from: { line: lineNum, ch: 0 },
							to: { line: lineNum, ch: lineText.length },
							text: newContent
						};
					}
					return undefined;
				}
			);

		} else {
			// Background file: Use vault.process() (existing logic, one by one)
			console.log(`Applying ${fileUpdates.length} file updates using Vault API (background file)`);

			for (const update of fileUpdates) {
				try {
					await vault.process(file, (content) => {
						const lines = content.split('\n');
						const tidPattern = new RegExp(`%%\\[tid:: \\[${update.tid}\\]`);

						// Search for task by TID in file AGAIN (might have moved)
						for (let i = 0; i < lines.length; i++) {
							if (tidPattern.test(lines[i])) {
								// Found task - update it
								lines[i] = update.newContent;
								console.log(`Updated task ${update.tid} in file`);
								break;
							}
						}

						return lines.join('\n');
					});
				} catch (error) {
					console.error(`Failed to update task ${update.tid} in file:`, error);
					// Continue with next task
				}
			}
		}
	}
}

/**
 * Bidirectional check: DB → File
 * Detects tasks that moved out of file or were deleted.
 * k-note lines 2677-2683
 *
 * OPTIMIZATION: Now runs BEFORE processNewTasks(), using already-extracted task list.
 * No need to re-read file - we already have all TIDs from the initial parse.
 * This is faster, simpler, and catches deletions earlier (before any API calls).
 *
 * @param file - Current file
 * @param existingTasks - Tasks with TIDs found in file (from initial parse)
 * @param vault - Obsidian vault
 * @param metadataCache - Metadata cache
 * @param db - Database instance
 */
async function bidirectionalCheck(
	file: TFile,
	existingTasks: Array<{ lineNum: number; line: string; tid: string | null }>,
	vault: Vault,
	metadataCache: MetadataCache,
	db: Database
): Promise<void> {
	console.log(`Bidirectional check for file: ${file.path}`);

	// Get all DB tasks for this file
	const dbTasksForFile = db.getTasksForFile(file.path);

	if (dbTasksForFile.length === 0) {
		return;  // No tasks in DB for this file
	}

	// Collect TIDs present in file (from already-parsed existingTasks)
	// No need to re-read file - we have the data from line 77-78!
	const tidsInFile = new Set<string>();
	for (const task of existingTasks) {
		if (task.tid) {
			tidsInFile.add(task.tid);
		}
	}

	// Check each DB task - is it in file?
	for (const [tid, dbTask] of dbTasksForFile) {
		if (!tidsInFile.has(tid)) {
			// Task in DB but NOT in file - moved or deleted!
			console.log(`Task ${tid} not found in file, searching vault...`);

			// Vault-wide TID search
			const newLocation = await searchVaultForTID(tid, vault, metadataCache, file);

			if (newLocation) {
				// Task MOVED to different file
				console.log(`Task ${tid} moved from ${file.path} to ${newLocation.path}`);
				dbTask.filepath = newLocation.path;
			} else {
				// Task DELETED from Obsidian
				console.log(`Task ${tid} deleted from vault`);
				dbTask.pending_changes.push({
					source: 'local',
					timestamp: Date.now(),
					changes: { deleted: true }
				});
			}
		}
	}
}

/**
 * Search vault-wide for TID (moved task detection).
 * Only searches files with todoist-sync: true frontmatter.
 * Uses chunking + yielding to avoid blocking UI.
 * k-note lines 2858-2882
 *
 * @param tid - Task ID to search for
 * @param vault - Obsidian vault
 * @param metadataCache - Metadata cache
 * @param excludeFile - File to exclude from search (current file)
 * @returns File containing TID, or null if not found
 */
export async function searchVaultForTID(
	tid: string,
	vault: Vault,
	metadataCache: MetadataCache,
	excludeFile: TFile
): Promise<TFile | null> {
	console.log(`Searching vault for TID: ${tid}`);

	// Get all files with todoist-sync: true (pre-filter)
	const allFiles = vault.getMarkdownFiles();
	const syncFiles = allFiles.filter(f => {
		if (f.path === excludeFile.path) return false;  // Exclude current file

		const cache = metadataCache.getFileCache(f);
		return cache?.frontmatter?.['todoist-sync'] === true;
	});

	console.log(`Searching ${syncFiles.length} sync-enabled files...`);

	// TID pattern
	const tidPattern = new RegExp(`%%\\[tid:: \\[${tid}\\]`);

	// Chunk processing: 30 files per chunk
	const CHUNK_SIZE = 30;

	for (let i = 0; i < syncFiles.length; i += CHUNK_SIZE) {
		const chunk = syncFiles.slice(i, i + CHUNK_SIZE);

		for (const file of chunk) {
			try {
				const content = await vault.cachedRead(file);

				if (tidPattern.test(content)) {
					console.log(`Found TID ${tid} in file: ${file.path}`);
					return file;
				}
			} catch (error) {
				console.error(`Error reading file ${file.path}:`, error);
				// Continue searching
			}
		}

		// Yield to UI after each chunk
		await nextFrame();
	}

	console.log(`TID ${tid} not found in vault`);
	return null;
}

/**
 * Delete task lines from Obsidian file.
 * Handles both active (editor) and background (vault) files.
 *
 * @param file - File to delete tasks from
 * @param taskIds - Array of task IDs to delete
 * @param editor - Editor (if active file), null otherwise
 * @param vault - Obsidian vault
 */
async function deleteTasksFromFile(
	file: TFile,
	taskIds: string[],
	editor: Editor | null,
	vault: Vault
): Promise<void> {
	console.log(`Deleting ${taskIds.length} tasks from file: ${file.path}`);

	// Create Set for O(1) lookup
	const tidsToDelete = new Set(taskIds);

	if (editor) {
		// Active file: Use editor.processLines() to delete lines atomically
		let deletedCount = 0;

		editor.processLines<boolean>(
			// Phase 1: Check if line contains TID to delete
			(lineNum, lineText) => {
				const tid = extractTID(lineText);
				return tid !== null && tidsToDelete.has(tid);
			},
			// Phase 2: Delete matched lines
			(lineNum, lineText, shouldDelete) => {
				if (shouldDelete) {
					deletedCount++;
					// Return empty text to delete the line
					return {
						from: { line: lineNum, ch: 0 },
						to: { line: lineNum + 1, ch: 0 },  // Include newline
						text: ''
					};
				}
				return undefined;  // Keep line unchanged
			}
		);

		console.log(`Deleted ${deletedCount} lines from active editor`);

	} else {
		// Background file: Use vault.process() to filter lines
		await vault.process(file, (content) => {
			const lines = content.split('\n');
			const newLines = lines.filter((line) => {
				const tid = extractTID(line);
				// Keep line if it doesn't have a TID we want to delete
				return !(tid && tidsToDelete.has(tid));
			});

			console.log(`Deleted ${lines.length - newLines.length} lines from background file`);
			return newLines.join('\n');
		});
	}
}
