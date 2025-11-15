// Sync Processor - Process single file with task detection and updates
// Handles new tasks, existing tasks, bidirectional checking, and conflict resolution

import { TFile, Vault, MetadataCache, Workspace, MarkdownView, Editor, Notice, EditorChange } from 'obsidian';
import { v4 as uuidv4 } from 'uuid';
import { Database } from './database';
import { SyncSettings, TaskData, TaskInDB } from './types';
import { isMarkdownTask, extractTID, nextFrame, getIndentLevel, buildIndent, getIndentUnit } from './utils';
import { parseTaskLine, parseTaskContent, buildTaskLine, insertTID } from './taskParser';
import { syncBatchCreate, syncBatchUpdate, syncBatchDelete, syncBatchMove } from './todoistAPI';
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
	settings: SyncSettings,
	files: TFile[],
	queuedPaths: Set<string>
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

	// Get indent unit from Obsidian editor settings (tabs or spaces)
	const indentUnit = getIndentUnit(workspace);

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
	const allTasks: Array<{
		lineNum: number;
		line: string;
		tid: string | null;
		parent_tid: string | null;
		parent_content: string | null;
	}> = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (isMarkdownTask(line)) {
			const tid = extractTID(line);
			allTasks.push({
				lineNum: i,
				line,
				tid,
				parent_tid: null,
				parent_content: null
			});
		}
	}

	console.log(`Found ${allTasks.length} tasks in file`);

	// PHASE 1: Detect parent relationships using MetadataCache.listItems
	const listItems = cache?.listItems;
	if (listItems && listItems.length > 0) {
		console.log(`Detecting parent relationships for ${allTasks.length} tasks...`);

		// Build map: line number → ListItemCache for O(1) lookup
		const lineToListItem = new Map(listItems.map(item => [item.position.start.line, item]));

		for (const task of allTasks) {
			const listItem = lineToListItem.get(task.lineNum);

			// Skip if no ListItemCache (shouldn't happen for tasks, but be safe)
			if (!listItem) {
				console.warn(`No ListItemCache for task at line ${task.lineNum}`);
				continue;
			}

			// Skip if this ListItemCache is not a task (should never happen)
			if (listItem.task === undefined) {
				console.warn(`ListItemCache at line ${task.lineNum} is not a task`);
				continue;
			}

			// Check if has parent (parent >= 0 means has parent)
			if (listItem.parent < 0) {
				// Root level task - no parent
				task.parent_tid = null;
				task.parent_content = null;
				continue;
			}

			// Has parent - get parent line
			const parentLine = listItem.parent;
			const parentLineText = lines[parentLine];

			// Check if parent is also a task
			if (!isMarkdownTask(parentLineText)) {
				// Parent is regular list item (not a task) - treat child as root
				console.log(`Task at line ${task.lineNum} has non-task parent at line ${parentLine}, treating as root`);
				task.parent_tid = null;
				task.parent_content = null;
				continue;
			}

			// Parent is a task! Extract parent TID
			const parentTid = extractTID(parentLineText);

			if (parentTid) {
				// Parent has TID - store parent_tid
				task.parent_tid = parentTid;
				task.parent_content = null;
				console.log(`Task at line ${task.lineNum} has parent TID: ${parentTid}`);
			} else {
				// Parent has no TID (also new task) - store parent_content for later resolution
				const parentTaskData = parseTaskLine(parentLineText);
				if (parentTaskData) {
					task.parent_tid = null;
					task.parent_content = parseTaskContent(parentLineText);
					console.log(`Task at line ${task.lineNum} has parent_content: ${task.parent_content.substring(0, 40)}`);
				} else {
					console.warn(`Failed to parse parent task at line ${parentLine}`);
				}
			}
		}
	}

	// Separate new vs existing tasks
	const newTasks = allTasks.filter(t => t.tid === null);
	const existingTasks = allTasks.filter(t => t.tid !== null);

	console.log(`New tasks: ${newTasks.length}, Existing tasks: ${existingTasks.length}`);

	// PHASE 2: Process new tasks FIRST (create on Todoist API, write TIDs back, build contentToTid map)
	let contentToTid: Map<string, string>;
	if (newTasks.length > 0) {
		contentToTid = await processNewTasks(file, newTasks, vault, editor, db, settings, frontmatterLabels, indentUnit);
	} else {
		contentToTid = new Map();
	}

	// PHASE 3: Reconcile existing tasks (detect parent_tid changes, use contentToTid map)
	// Handles File→DB and DB→File, detects moves/deletions/changes, queues moved files
	// Pass newly created TIDs to prevent false deletion detection
	const newlyCreatedTIDs = new Set(contentToTid.values());
	await reconcileFileTasks(file, existingTasks, contentToTid, newlyCreatedTIDs, vault, metadataCache, db, files, queuedPaths);

	// PHASE 4 & 5: Resolve all pending changes for this file (conflicts, cross-file validation, API updates, file write-back)
	await resolveAndApplyUpdates(file, vault, editor, db, settings, indentUnit);

	console.log(`Finished processing file: ${file.path}`);
}

/**
 * Process new tasks: batch create on API, write TIDs back to file.
 * PHASE 2: Level-by-level creation with parent support.
 * Uses full content match to find tasks after API creation.
 * k-note lines 2297-2357, 2640-2661
 *
 * @param file - File containing new tasks
 * @param newTasks - Array of new tasks (no TID, with parent info)
 * @param vault - Obsidian vault
 * @param editor - Editor (if active file), null otherwise
 * @param db - Database instance
 * @param settings - Plugin settings
 * @param frontmatterLabels - Labels from file frontmatter
 * @returns contentToTid map for Phase 3 parent resolution
 */
async function processNewTasks(
	file: TFile,
	newTasks: Array<{
		lineNum: number;
		line: string;
		tid: string | null;
		parent_tid: string | null;
		parent_content: string | null;
	}>,
	vault: Vault,
	editor: Editor | null,
	db: Database,
	settings: SyncSettings,
	frontmatterLabels: string[],
	indentUnit: string
): Promise<Map<string, string>> {
	console.log(`Processing ${newTasks.length} new tasks with level-by-level creation...`);

	// PHASE 2: Calculate levels and group by level
	const contentToTid = new Map<string, string>();  // Maps content → TID for parent resolution

	if (newTasks.length === 0) {
		return contentToTid;
	}

	// Step 1: Calculate level for each task
	interface TaskWithLevel {
		task: typeof newTasks[number];
		level: number;
	}

	const tasksWithLevels: TaskWithLevel[] = [];

	for (const task of newTasks) {
		let level = 0;

		// If has parent_tid (existing task as parent), level = 1
		if (task.parent_tid) {
			level = 1;  // Simplified: all existing-parent children are level 1
		}
		// If has parent_content (new task as parent), calculate level recursively
		else if (task.parent_content) {
			// Find parent in newTasks by matching content
			const parentTask = newTasks.find(t => {
				const tContent = parseTaskContent(t.line);
				return tContent === task.parent_content && t.lineNum < task.lineNum;
			});

			if (parentTask) {
				// Parent found - need to calculate parent's level first
				// Use iterative approach to avoid recursion
				const parentLevel = calculateTaskLevel(parentTask, newTasks);
				level = parentLevel + 1;
			} else {
				// Parent not found - ERROR, treat as root
				console.error(`Parent content not found for task at line ${task.lineNum}: "${task.parent_content?.substring(0, 40)}"`);
				level = 0;
			}
		}
		// No parent - root level
		else {
			level = 0;
		}

		tasksWithLevels.push({ task, level });
	}

	// Helper function to calculate task level iteratively
	function calculateTaskLevel(
		targetTask: typeof newTasks[number],
		allNewTasks: typeof newTasks
	): number {
		const visited = new Set<number>();
		let current = targetTask;
		let level = 0;

		while (current.parent_content) {
			// Circular reference detection
			if (visited.has(current.lineNum)) {
				console.error(`Circular reference detected at line ${current.lineNum}`);
				return 0;
			}
			visited.add(current.lineNum);

			// Find parent
			const parent = allNewTasks.find(t => {
				const tContent = parseTaskContent(t.line);
				return tContent === current.parent_content && t.lineNum < current.lineNum;
			});

			if (!parent) break;

			level++;
			current = parent;
		}

		// Add 1 more if final parent has parent_tid (existing task)
		if (current.parent_tid) {
			level++;
		}

		return level;
	}

	// Step 2: Group by level
	const tasksByLevel = new Map<number, TaskWithLevel[]>();
	for (const twl of tasksWithLevels) {
		if (!tasksByLevel.has(twl.level)) {
			tasksByLevel.set(twl.level, []);
		}
		tasksByLevel.get(twl.level)!.push(twl);
	}

	const maxLevel = Math.max(...tasksByLevel.keys());
	console.log(`Task levels: ${Array.from(tasksByLevel.keys()).sort((a, b) => a - b).join(', ')} (max: ${maxLevel})`);

	// Step 3: Process level-by-level (0, 1, 2, ...)
	for (let level = 0; level <= maxLevel; level++) {
		const levelTasks = tasksByLevel.get(level);
		if (!levelTasks || levelTasks.length === 0) continue;

		console.log(`Creating ${levelTasks.length} tasks at level ${level}...`);

		// Build commands for this level
		const commands = levelTasks.map((twl, index) => {
			const taskData = parseTaskLine(twl.task.line);
			if (!taskData) {
				console.error(`Failed to parse task line: ${twl.task.line}`);
				return null;
			}

			// Resolve parent_id for non-root tasks
			let parent_id: string | undefined = undefined;

			if (twl.task.parent_tid) {
				// Parent is existing task - use TID directly
				parent_id = twl.task.parent_tid;
			} else if (twl.task.parent_content) {
				// Parent is new task - look up in contentToTid map
				const resolvedParentTid = contentToTid.get(twl.task.parent_content);
				if (resolvedParentTid) {
					parent_id = resolvedParentTid;
				} else {
					// Parent not in map - creation must have failed
					console.error(`Parent task creation failed for content: "${twl.task.parent_content.substring(0, 40)}", creating child as root`);
					parent_id = undefined;  // Create as root (graceful fallback)
				}
			}

			return {
				temp_id: `level${level}-${index}`,
				content: taskData.content,
				labels: [...new Set(['tdsync', ...frontmatterLabels, ...taskData.labels])],
				project_id: settings.defaultProjectId,
				parent_id,  // NEW: Parent support
				due_date: taskData.dueDate,
				due_datetime: taskData.dueDatetime,
				priority: taskData.priority,
				duration: taskData.duration
			};
		}).filter(cmd => cmd !== null);

		if (commands.length === 0) {
			console.warn(`No valid tasks to create at level ${level}`);
			continue;
		}

		// Batch create for this level
		try {
			const response = await syncBatchCreate(
				settings.todoistAPIToken,
				commands as any[]
			);

			console.log(`Created ${Object.keys(response.temp_id_mapping).length} tasks at level ${level}`);

			// Update sync token
			settings.syncToken = response.sync_token;

			// Store in contentToTid map for next levels
			for (let i = 0; i < levelTasks.length; i++) {
				const tempId = `level${level}-${i}`;
				const realTID = response.temp_id_mapping[tempId];

				if (realTID) {
					const taskContent = parseTaskContent(levelTasks[i].task.line);
					contentToTid.set(taskContent, realTID);
					console.log(`Mapped content → TID: "${taskContent.substring(0, 40)}" → ${realTID}`);
				} else {
					console.error(`No TID mapping for temp_id: ${tempId}`);
				}
			}

		} catch (error) {
			console.error(`Failed to create tasks at level ${level}:`, error);
			new Notice(`Failed to create tasks: ${error instanceof Error ? error.message : 'Unknown error'}`);
			throw error;
		}
	}

	console.log(`All ${newTasks.length} new tasks created across ${maxLevel + 1} levels`);

	// Step 4: Write TIDs back to file (same logic as before, but with parent support in DB)
	console.log(`Writing TIDs back to file using contentToTid map...`);

	// Write TIDs back to file using the contentToTid map from level-by-level creation
	// Use editor.transaction() for active files (preserves cursor)
	// Use vault.process() for background files (atomic)
	if (editor) {
		// Active file: Use editor.transaction() for atomic TID insertion
		console.log('Writing TIDs using Editor API (active file)');

		// Build changes array by iterating through file
		const changes: EditorChange[] = [];
		const writtenTIDs = new Set<string>();
		const totalLines = editor.lineCount();

		console.log(`Scanning ${totalLines} lines to write ${newTasks.length} TIDs...`);

		// Match tasks by content using contentToTid map
		for (let lineNum = 0; lineNum < totalLines; lineNum++) {
			const line = editor.getLine(lineNum);

			// Skip lines that already have TIDs
			if (extractTID(line)) continue;

			// Parse this line
			const currentTask = parseTaskLine(line);
			if (!currentTask) continue;

			// Look up TID in contentToTid map
			const taskContent = parseTaskContent(line);
			const realTID = contentToTid.get(taskContent);

			if (!realTID || writtenTIDs.has(realTID)) continue;

			console.log(`  Line ${lineNum}: Matched content "${currentTask.content.substring(0, 40)}" → TID ${realTID}`);

			// Find original task to get parent info
			const originalTask = newTasks.find(t => parseTaskContent(t.line) === taskContent);
			const parent_tid = originalTask?.parent_tid || null;

			// Build new line with TID, preserving original indentation
			currentTask.tid = realTID;
			const indent = getIndentLevel(line);
			const newLine = buildTaskLineWithIndent(currentTask, frontmatterLabels, indent, indentUnit);

			// Add to DB with parent_tid
			db.setTask(realTID, {
				tid: realTID,
				filepath: file.path,
				content: currentTask.content,
				completed: currentTask.completed,
				dueDate: currentTask.dueDate,
				dueTime: currentTask.dueTime,
				dueDatetime: currentTask.dueDatetime,
				priority: currentTask.priority,
				duration: currentTask.duration,
				labels: [...new Set(['tdsync', ...frontmatterLabels, ...currentTask.labels])],
				parent_tid,  // NEW: Store parent relationship
				lastSyncedAt: Date.now(),
				pending_changes: []
			});

			writtenTIDs.add(realTID);

			// Queue change if line content differs
			if (newLine !== line) {
				changes.push({
					from: { line: lineNum, ch: 0 },
					to: { line: lineNum, ch: line.length },
					text: newLine
				});
			}
		}

		// Apply all TID changes atomically
		if (changes.length > 0) {
			console.log(`Applying ${changes.length} TID insertions atomically via editor.transaction()`);
			editor.transaction({ changes });
			console.log(`✓ TIDs written successfully`);
		}

		// Check for unmatched tasks (created on API but not found in file)
		for (const [content, tid] of contentToTid.entries()) {
			if (!writtenTIDs.has(tid)) {
				console.error(`Task not found in file: content "${content.substring(0, 50)}..."`);
				new Notice(`Task disappeared during sync - deleting from Todoist`);
				syncBatchDelete(settings.todoistAPIToken, [tid])
					.catch(err => console.error('Failed to delete ghost task:', err));
			}
		}

	} else {
		// Background file: Use vault.process()
		console.log('Writing TIDs using Vault API (background file)');

		const writtenTIDs = new Set<string>();

		await vault.process(file, (currentContent) => {
			const currentLines = currentContent.split('\n');

			// Match tasks by content using contentToTid map
			for (let lineIdx = 0; lineIdx < currentLines.length; lineIdx++) {
				const currentLine = currentLines[lineIdx];

				// Skip lines that already have TIDs
				if (extractTID(currentLine)) continue;

				// Parse task
				const taskData = parseTaskLine(currentLine);
				if (!taskData) continue;

				// Look up TID in contentToTid map
				const taskContent = parseTaskContent(currentLine);
				const realTID = contentToTid.get(taskContent);

				if (!realTID || writtenTIDs.has(realTID)) continue;

				// Find original task to get parent info
				const originalTask = newTasks.find(t => parseTaskContent(t.line) === taskContent);
				const parent_tid = originalTask?.parent_tid || null;

				// Add TID to line, preserving original indentation
				taskData.tid = realTID;
				const indent = getIndentLevel(currentLine);
				currentLines[lineIdx] = buildTaskLineWithIndent(taskData, frontmatterLabels, indent, indentUnit);

				// Add to DB with parent_tid
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
					parent_tid,  // NEW: Store parent relationship
					lastSyncedAt: Date.now(),
					pending_changes: []
				});

				writtenTIDs.add(realTID);
			}

			return currentLines.join('\n');
		});

		// Check for unmatched tasks (created on API but not found in file)
		for (const [content, tid] of contentToTid.entries()) {
			if (!writtenTIDs.has(tid)) {
				console.error(`Task not found in file: content "${content.substring(0, 50)}..."`);
				new Notice(`Task disappeared during sync - deleting from Todoist`);
				syncBatchDelete(settings.todoistAPIToken, [tid])
					.catch(err => console.error('Failed to delete ghost task:', err));
			}
		}
	}

	// Return contentToTid map for Phase 3
	return contentToTid;
}

/**
 * PHASE 5 HELPER: Calculate indent level from parent chain.
 * Traverses parent hierarchy in DB to determine nesting depth.
 *
 * @param taskTid - Task ID to calculate indent for
 * @param db - Database instance
 * @param tidToLineNum - Map of TID → line number (from current file scan)
 * @param fileLines - File content split by lines
 * @returns Indent level (0 = root, 1 = child, 2 = grandchild, etc.)
 */
function calculateIndentFromParentChain(
	taskTid: string,
	db: Database,
	tidToLineNum: Map<string, number>,
	fileLines: string[]
): number {
	const visited = new Set<string>();
	let currentTid: string | null = taskTid;
	let depth = 0;
	const MAX_DEPTH = 20;  // Prevent infinite loops

	while (currentTid && depth < MAX_DEPTH) {
		// Circular reference detection
		if (visited.has(currentTid)) {
			console.error(`Circular parent reference detected for task ${taskTid}`);
			return 0;
		}
		visited.add(currentTid);

		// Get parent from DB
		const task = db.getTask(currentTid);
		if (!task || !task.parent_tid) {
			// Reached root or task not found
			return depth;
		}

		// Check if parent exists in current file
		const parentLineNum = tidToLineNum.get(task.parent_tid);
		if (parentLineNum === undefined) {
			// Parent not in file - can't calculate indent from it
			console.warn(`Parent ${task.parent_tid} not found in file for task ${taskTid}, using indent=${depth}`);
			return depth;
		}

		// Parent exists - continue up the chain
		currentTid = task.parent_tid;
		depth++;
	}

	if (depth >= MAX_DEPTH) {
		console.error(`Max depth reached for task ${taskTid}, possible circular reference`);
	}

	return depth;
}

/**
 * PHASE 5 HELPER: Find insert position for repositioned task (after last sibling).
 * Queries DB for siblings, finds their current line numbers, returns position after last sibling.
 *
 * @param taskTid - Task ID being repositioned
 * @param parentTid - Parent task ID (null for root)
 * @param filepath - Current file path
 * @param db - Database instance
 * @param tidToLineNum - Map of TID → line number (from current file scan)
 * @param totalLines - Total number of lines in file (for fallback)
 * @returns Line number to insert at (0-based)
 */
function findSiblingInsertPosition(
	taskTid: string,
	parentTid: string | null,
	filepath: string,
	db: Database,
	tidToLineNum: Map<string, number>,
	totalLines: number
): number {
	// Get all tasks in same file with same parent (siblings)
	const allTasksInFile = db.getTasksForFile(filepath);
	const siblings: number[] = [];

	for (const [tid, task] of allTasksInFile) {
		// Skip self
		if (tid === taskTid) continue;

		// Check if same parent
		const taskParent = task.parent_tid || null;
		if (taskParent === parentTid) {
			// Sibling found - get current line number
			const lineNum = tidToLineNum.get(tid);
			if (lineNum !== undefined) {
				siblings.push(lineNum);
			}
		}
	}

	if (siblings.length > 0) {
		// Insert after last sibling
		siblings.sort((a, b) => a - b);
		return siblings[siblings.length - 1] + 1;
	}

	// No siblings - insert after parent (if parent exists)
	if (parentTid) {
		const parentLineNum = tidToLineNum.get(parentTid);
		if (parentLineNum !== undefined) {
			return parentLineNum + 1;
		}
	}

	// No siblings, no parent in file - insert at end
	return totalLines;
}

/**
 * PHASE 5 HELPER: Build task line with specific indentation.
 * Strips existing indent, adds new indent based on hierarchy.
 *
 * @param taskData - Task data to build line from
 * @param frontmatterLabels - Labels from frontmatter (excluded from inline)
 * @param indent - Indent level (0 = root, 1 = child, etc.)
 * @returns Task line with correct indentation
 */
function buildTaskLineWithIndent(
	taskData: TaskData,
	frontmatterLabels: string[],
	indent: number,
	indentUnit: string
): string {
	// Build line without indent
	const baseLine = buildTaskLine(taskData, frontmatterLabels);

	// Strip any existing indentation
	const strippedLine = baseLine.replace(/^[\s]*/, '');

	// Add new indentation using Obsidian's indent settings
	const indentPrefix = buildIndent(indent, indentUnit);
	return indentPrefix + strippedLine;
}

/**
 * Resolve conflicts and apply updates for all tasks with pending changes.
 * Batch updates to Todoist, then write back to Obsidian.
 * PHASE 5: Includes smart repositioning logic for parent changes.
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
	settings: SyncSettings,
	indentUnit: string
): Promise<void> {
	// Get all tasks with pending changes FOR THIS FILE ONLY!
	// CRITICAL: Don't process tasks from other files - they'll be handled when those files are processed
	const allModifiedTasks = db.getModifiedTasks();
	const tasksToUpdate = allModifiedTasks.filter(([_, task]) => task.filepath === file.path);

	if (tasksToUpdate.length === 0) {
		return;  // Nothing to update for this file
	}

	console.log(`Resolving conflicts for ${tasksToUpdate.length} tasks in file ${file.path}...`);

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

	const apiMoves: Array<{ id: string; parent_id: string | null; project_id?: string }> = [];  // NEW: Parent changes (item_move)
	const fileUpdates: Array<{ tid: string; newContent: string; needsReposition: boolean }> = [];
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

		// PHASE 4: Cross-file parent validation
		let resolvedParentTid = resolution.changes.parent_tid;
		let needsReposition = false;

		if (resolvedParentTid !== undefined) {
			// Parent changed - check cross-file validity
			if (resolvedParentTid !== null) {
				const parentTask = db.getTask(resolvedParentTid);
				if (parentTask && parentTask.filepath !== task.filepath) {
					// Cross-file parent detected - detach child to root
					console.warn(`Task ${tid} has parent ${resolvedParentTid} in different file (${parentTask.filepath}), detaching to root`);
					resolvedParentTid = null;
				}
			}

			// If parent_tid changed, mark for repositioning (Phase 5)
			if (resolvedParentTid !== task.parent_tid) {
				needsReposition = true;
			}
		} else {
			// parent_tid not in resolution (unchanged) - use DB value
			resolvedParentTid = task.parent_tid;
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

			// Parent changes require item_move (separate from item_update)
			if (resolvedParentTid !== task.parent_tid) {
				if (resolvedParentTid === null) {
					// Moving to root - use project_id (Todoist API doesn't support parent_id: null)
					console.log(`Moving task ${tid} to root (project_id: ${settings.defaultProjectId})`);
					apiMoves.push({ id: tid, parent_id: null, project_id: settings.defaultProjectId });
				} else {
					// Moving to parent - use parent_id
					console.log(`Moving task ${tid} to parent ${resolvedParentTid}`);
					apiMoves.push({ id: tid, parent_id: resolvedParentTid });
				}
			}

			// Update DB state with local changes
			task.content = resolution.changes.content || task.content;
			task.completed = resolution.changes.completed ?? task.completed;
			task.dueDate = resolution.changes.dueDate;
			task.dueDatetime = resolution.changes.dueDatetime;
			task.priority = resolution.changes.priority;
			task.duration = resolution.changes.duration;
			task.labels = resolution.changes.labels || task.labels;
			task.parent_tid = resolvedParentTid;  // NEW: Update parent

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

			// CRITICAL: Build newContent WITHOUT indent - Phase 5 will add indent based on current line
			// This is temporary content; actual indent added during file write
			fileUpdates.push({
				tid,
				newContent: buildTaskLine(updatedData, []),  // Indentation handled in Phase 5
				needsReposition  // Phase 5: Reposition if parent changed
			});

			// Update DB state with API changes
			task.content = updatedData.content;
			task.completed = updatedData.completed;
			task.dueDate = updatedData.dueDate;
			task.dueDatetime = updatedData.dueDatetime;
			task.priority = updatedData.priority;
			task.duration = updatedData.duration;
			task.labels = updatedData.labels;
			task.parent_tid = resolvedParentTid;  // NEW: Update parent
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

	// PHASE 4: Apply parent moves (batch item_move commands)
	if (apiMoves.length > 0) {
		try {
			console.log(`Pushing ${apiMoves.length} parent moves to Todoist...`);
			const response = await syncBatchMove(settings.todoistAPIToken, apiMoves);
			settings.syncToken = response.sync_token;
			console.log('API parent moves successful');
		} catch (error) {
			console.error('Failed to move tasks on API:', error);
			new Notice(`Failed to update task parents on Todoist: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

	// PHASE 5: Apply file updates (with smart repositioning)
	// Use editor.transaction() for active files (atomic, preserves cursor)
	// Use vault.process() for background files (atomic)
	if (fileUpdates.length > 0) {
		if (editor) {
			// Active file: Use editor.transaction() for atomic batch updates
			console.log(`Applying ${fileUpdates.length} file updates using Editor API (active file)`);

			// Step 1: Build TID → line number map (one scan for efficiency)
			const tidToLineNum = new Map<string, number>();
			const totalLines = editor.lineCount();
			const fileLines: string[] = [];

			for (let lineNum = 0; lineNum < totalLines; lineNum++) {
				const line = editor.getLine(lineNum);
				fileLines.push(line);
				const tid = extractTID(line);
				if (tid) {
					tidToLineNum.set(tid, lineNum);
				}
			}

			console.log(`Built TID map with ${tidToLineNum.size} tasks`);

			// Step 2: Split updates into in-place and reposition groups
			const inPlaceUpdates: typeof fileUpdates = [];
			const repositionUpdates: typeof fileUpdates = [];

			for (const update of fileUpdates) {
				if (update.needsReposition) {
					repositionUpdates.push(update);
				} else {
					inPlaceUpdates.push(update);
				}
			}

			console.log(`In-place updates: ${inPlaceUpdates.length}, Repositions: ${repositionUpdates.length}`);

			// Step 3: Build EditorChanges array
			const changes: EditorChange[] = [];

			// Process in-place updates (content replacement with indentation preservation)
			for (const update of inPlaceUpdates) {
				const currentLineNum = tidToLineNum.get(update.tid);
				if (currentLineNum === undefined) {
					console.warn(`Task ${update.tid} not found in file for in-place update`);
					continue;
				}

				const currentLine = fileLines[currentLineNum];

				// CRITICAL: Preserve current line's indentation
				const currentIndent = getIndentLevel(currentLine);
				const indentedNewContent = currentIndent > 0
					? buildIndent(currentIndent, indentUnit) + update.newContent.replace(/^[\s]*/, '')
					: update.newContent;

				if (indentedNewContent !== currentLine) {
					changes.push({
						from: { line: currentLineNum, ch: 0 },
						to: { line: currentLineNum, ch: currentLine.length },
						text: indentedNewContent
					});
					console.log(`  In-place update queued for ${update.tid} at line ${currentLineNum} (indent: ${currentIndent})`);
				}
			}

			// Process repositioning updates (delete old line + insert at new position)
			const repositionChanges: Array<{
				tid: string;
				oldLine: number;
				newLine: number;
				content: string;
			}> = [];

			for (const update of repositionUpdates) {
				const currentLineNum = tidToLineNum.get(update.tid);
				if (currentLineNum === undefined) {
					console.warn(`Task ${update.tid} not found in file for repositioning`);
					continue;
				}

				// Get task from DB for parent info
				const task = db.getTask(update.tid);
				if (!task) {
					console.warn(`Task ${update.tid} not in DB, skipping reposition`);
					continue;
				}

				// Calculate indent from parent chain
				const indent = calculateIndentFromParentChain(update.tid, db, tidToLineNum, fileLines);

				// Parse task data to rebuild with correct indent
				const taskData = parseTaskLine(fileLines[currentLineNum]);
				if (!taskData) {
					console.warn(`Failed to parse task ${update.tid} for repositioning`);
					continue;
				}

				// Build new line with calculated indent
				taskData.tid = update.tid;  // Ensure TID is set
				const newLineContent = buildTaskLineWithIndent(taskData, [], indent, indentUnit);

				// Find insert position (after last sibling or after parent)
				const insertPos = findSiblingInsertPosition(
					update.tid,
					task.parent_tid || null,
					file.path,
					db,
					tidToLineNum,
					totalLines
				);

				// Clamp insert position to valid range
				const clampedInsertPos = Math.min(insertPos, totalLines);

				// Check if repositioning is actually needed
				if (currentLineNum === clampedInsertPos && newLineContent === fileLines[currentLineNum]) {
					console.log(`  Task ${update.tid} already at correct position ${currentLineNum}, skipping`);
					continue;
				}

				repositionChanges.push({
					tid: update.tid,
					oldLine: currentLineNum,
					newLine: clampedInsertPos,
					content: newLineContent
				});

				console.log(`  Reposition queued: ${update.tid} from line ${currentLineNum} → ${clampedInsertPos} (indent=${indent})`);
			}

			// Step 4: Build EditorChanges for repositioning
			// Process repositions: delete old line, insert at new position
			// Sort by line number descending to avoid line number invalidation
			repositionChanges.sort((a, b) => b.oldLine - a.oldLine);

			for (const reposition of repositionChanges) {
				// Delete old line
				changes.push({
					from: { line: reposition.oldLine, ch: 0 },
					to: { line: reposition.oldLine + 1, ch: 0 },  // Include newline
					text: ''
				});

				// Insert at new position
				// CRITICAL: editor.transaction() applies ALL changes to ORIGINAL document state
				// No adjustment needed - all positions reference the original line numbers
				changes.push({
					from: { line: reposition.newLine, ch: 0 },
					to: { line: reposition.newLine, ch: 0 },
					text: reposition.content + '\n'
				});
			}

			// Step 5: Apply all changes atomically
			if (changes.length > 0) {
				console.log(`Applying ${changes.length} changes atomically via editor.transaction()`);
				editor.transaction({ changes });
				console.log(`✓ Changes applied successfully (${inPlaceUpdates.length} in-place, ${repositionChanges.length} repositioned)`);
			} else {
				console.log(`No changes to apply`);
			}

		} else {
			// Background file: Use vault.process()
			console.log(`Applying ${fileUpdates.length} file updates using Vault API (background file)`);

			await vault.process(file, (content) => {
				const lines = content.split('\n');

				// Build TID → line number map
				const tidToLineNum = new Map<string, number>();
				for (let i = 0; i < lines.length; i++) {
					const tid = extractTID(lines[i]);
					if (tid) {
						tidToLineNum.set(tid, i);
					}
				}

				// Split updates
				const inPlaceUpdates: typeof fileUpdates = [];
				const repositionUpdates: typeof fileUpdates = [];

				for (const update of fileUpdates) {
					if (update.needsReposition) {
						repositionUpdates.push(update);
					} else {
						inPlaceUpdates.push(update);
					}
				}

				// Process in-place updates (preserve indentation)
				for (const update of inPlaceUpdates) {
					const lineNum = tidToLineNum.get(update.tid);
					if (lineNum !== undefined) {
						// CRITICAL: Preserve current line's indentation
						const currentLine = lines[lineNum];
						const currentIndent = getIndentLevel(currentLine);
						const indentedNewContent = currentIndent > 0
							? buildIndent(currentIndent, indentUnit) + update.newContent.replace(/^[\s]*/, '')
							: update.newContent;
						lines[lineNum] = indentedNewContent;
					}
				}

				// Process repositions (mark for deletion, collect inserts)
				const linesToDelete = new Set<number>();
				const inserts: Array<{ position: number; content: string }> = [];

				for (const update of repositionUpdates) {
					const currentLineNum = tidToLineNum.get(update.tid);
					if (currentLineNum === undefined) continue;

					const task = db.getTask(update.tid);
					if (!task) continue;

					// Calculate indent
					const indent = calculateIndentFromParentChain(update.tid, db, tidToLineNum, lines);

					// Parse and rebuild with indent
					const taskData = parseTaskLine(lines[currentLineNum]);
					if (!taskData) continue;

					taskData.tid = update.tid;
					const newLineContent = buildTaskLineWithIndent(taskData, [], indent, indentUnit);

					// Find insert position
					const insertPos = findSiblingInsertPosition(
						update.tid,
						task.parent_tid || null,
						file.path,
						db,
						tidToLineNum,
						lines.length
					);

					const clampedInsertPos = Math.min(insertPos, lines.length);

					// Mark old line for deletion, queue insert
					linesToDelete.add(currentLineNum);
					inserts.push({ position: clampedInsertPos, content: newLineContent });
				}

				// Delete marked lines (from end to start to maintain indices)
				const deleteIndices = Array.from(linesToDelete).sort((a, b) => b - a);
				for (const idx of deleteIndices) {
					lines.splice(idx, 1);
				}

				// Insert new lines with adjusted positions (account for deletions)
				// For each insert position, count how many deleted lines are before it
				inserts.sort((a, b) => b.position - a.position);
				for (const insert of inserts) {
					// Count deletions before this insert position
					const deletionsBefore = Array.from(linesToDelete).filter(delIdx => delIdx < insert.position).length;

					// Adjust position: subtract deletions that occurred before this position
					const adjustedPos = Math.max(0, Math.min(insert.position - deletionsBefore, lines.length));

					lines.splice(adjustedPos, 0, insert.content);
				}

				return lines.join('\n');
			});
		}
	}
}

/**
 * Comprehensive task reconciliation: File ↔ DB bidirectional sync.
 * PHASE 3: Resolve parent_content, detect parent_tid changes.
 *
 * This function does EVERYTHING about task state reconciliation:
 * - Part 1: File → DB (check each task IN the file against DB)
 * - Part 2: DB → File (check each DB task for THIS filepath against file)
 * - Part 3: PHASE 3 - Resolve parent_content → parent_tid, detect parent changes
 * - Detects: moves, deletions, local changes, PARENT CHANGES
 * - Queues: files where moved tasks are found (for processing)
 * - Updates: DB state immediately (filepath, pending_changes)
 *
 * @param file - Current file being processed
 * @param existingTasks - Tasks with TIDs found in file (with parent info from Phase 1)
 * @param contentToTid - Map from Phase 2 (content → TID for new tasks)
 * @param vault - Obsidian vault
 * @param metadataCache - Metadata cache
 * @param db - Database instance
 * @param files - Files array (for appending moved task destinations)
 * @param queuedPaths - Set of already-queued file paths (deduplication)
 */
async function reconcileFileTasks(
	file: TFile,
	existingTasks: Array<{
		lineNum: number;
		line: string;
		tid: string | null;
		parent_tid: string | null;
		parent_content: string | null;
	}>,
	contentToTid: Map<string, string>,
	newlyCreatedTIDs: Set<string>,
	vault: Vault,
	metadataCache: MetadataCache,
	db: Database,
	files: TFile[],
	queuedPaths: Set<string>
): Promise<void> {
	console.log(`Reconciling tasks for file: ${file.path}`);

	// PART 1: File → DB
	// Check each task that EXISTS in the file
	for (const task of existingTasks) {
		if (!task.tid) continue;  // Should never happen (existingTasks are filtered)

		const dbTask = db.getTask(task.tid);

		if (!dbTask) {
			// Task has TID but NOT in our DB - orphaned/corrupted
			// This shouldn't happen in normal operation (DB lost or manual TID added)
			console.error(`Orphaned task ${task.tid} found in file but not in DB:`, task.line.substring(0, 50));
			new Notice(`Found task with unknown ID in ${file.basename} - skipping`);
			continue;  // Skip this task - we can't manage what we don't track
		}

		// Task exists in DB - check if it moved TO this file
		if (dbTask.filepath !== file.path) {
			console.log(`Task ${task.tid} moved from ${dbTask.filepath} to ${file.path}`);
			dbTask.filepath = file.path;  // Update DB filepath immediately
		}

		// PHASE 3: Resolve parent_content → parent_tid
		let resolvedParentTid = task.parent_tid;  // Start with parent_tid from Phase 1

		if (task.parent_content && !resolvedParentTid) {
			// Parent is new task - look up in contentToTid map
			resolvedParentTid = contentToTid.get(task.parent_content) || null;
			if (!resolvedParentTid) {
				console.warn(`Failed to resolve parent_content for task ${task.tid}: "${task.parent_content.substring(0, 40)}"`);
			}
		}

		// Compare task content with DB - detect local changes
		const currentTaskData = parseTaskLine(task.line);
		if (!currentTaskData) {
			console.warn(`Failed to parse task ${task.tid}:`, task.line.substring(0, 50));
			continue;
		}

		// Check if any field changed (including parent_tid!)
		const parentChanged = resolvedParentTid !== (dbTask.parent_tid || null);
		const contentChanged = currentTaskData.content !== dbTask.content;
		const completedChanged = currentTaskData.completed !== dbTask.completed;
		const dueDateChanged = currentTaskData.dueDate !== dbTask.dueDate;
		const dueDatetimeChanged = currentTaskData.dueDatetime !== dbTask.dueDatetime;
		const priorityChanged = currentTaskData.priority !== dbTask.priority;
		const durationChanged = currentTaskData.duration !== dbTask.duration;
		const labelsChanged = JSON.stringify(currentTaskData.labels) !== JSON.stringify(dbTask.labels);

		if (contentChanged || completedChanged || dueDateChanged || dueDatetimeChanged || priorityChanged || durationChanged || labelsChanged || parentChanged) {
			// BUG FIX #6: Prevent CASCADE BUG where our own writes trigger false "local changes"
			// Check if file was recently modified by OUR sync (within 5 seconds of lastSyncedAt)
			// If yes, skip creating local pending_changes because WE wrote that state, not the user
			const recentlyModifiedByUs = dbTask.lastSyncedAt &&
										 Math.abs(file.stat.mtime - dbTask.lastSyncedAt) < 5000;  // 5 second window

			if (recentlyModifiedByUs) {
				console.log(`Skipping local pending_changes for ${task.tid} - file modified by recent sync (mtime: ${new Date(file.stat.mtime)}, lastSync: ${new Date(dbTask.lastSyncedAt)})`);
				continue;
			}

			// Local changes detected - add to pending_changes
			console.log(`Local changes detected for task ${task.tid}${parentChanged ? ' (parent changed)' : ''}`);
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
					labels: currentTaskData.labels,
					parent_tid: resolvedParentTid  // NEW: Track parent changes
				}
			});
		}
	}

	// PART 2: DB → File
	// Check each task that DB thinks belongs to THIS file
	const dbTasksForFile = db.getTasksForFile(file.path);

	if (dbTasksForFile.length === 0) {
		return;  // No DB tasks for this file, nothing more to check
	}

	// Collect TIDs present in file for fast lookup
	// Include both existing tasks AND newly created tasks from Phase 2
	const tidsInFile = new Set<string>();
	for (const task of existingTasks) {
		if (task.tid) {
			tidsInFile.add(task.tid);
		}
	}
	// Add newly created tasks to prevent false deletion detection
	for (const tid of newlyCreatedTIDs) {
		tidsInFile.add(tid);
	}

	// Check each DB task - is it actually in the file?
	for (const [tid, dbTask] of dbTasksForFile) {
		if (tidsInFile.has(tid)) {
			// Task found in file - already handled in Part 1
			continue;
		}

		// Task in DB but NOT in file - moved or deleted!
		console.log(`Task ${tid} not found in file, searching vault...`);

		// Search vault-wide for this TID
		const newLocation = await searchVaultForTID(tid, vault, metadataCache, file);

		if (newLocation) {
			// Task MOVED to different file
			console.log(`Task ${tid} moved from ${file.path} to ${newLocation.path}`);
			dbTask.filepath = newLocation.path;  // Update DB filepath

			// Queue the destination file for processing (if not already queued)
			if (!queuedPaths.has(newLocation.path)) {
				console.log(`Queueing moved task destination: ${newLocation.path}`);
				files.push(newLocation);
				queuedPaths.add(newLocation.path);
			}
		} else {
			// Task DELETED from Obsidian (not found anywhere)
			console.log(`Task ${tid} deleted from vault`);
			dbTask.pending_changes.push({
				source: 'local',
				timestamp: Date.now(),
				changes: { deleted: true }
			});
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
