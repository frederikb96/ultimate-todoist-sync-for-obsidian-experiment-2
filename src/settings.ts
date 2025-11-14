import { App, PluginSettingTab, Setting, Modal } from 'obsidian';
import TodoistSyncPlugin from './main';

export class TodoistSettingTab extends PluginSettingTab {
	plugin: TodoistSyncPlugin;

	constructor(app: App, plugin: TodoistSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Todoist Sync Settings' });

		// Migration section (first-time setup)
		containerEl.createEl('h3', { text: 'Migration' });

		const migrationDesc = containerEl.createEl('p', { cls: 'setting-item-description' });
		migrationDesc.setText('Import existing tasks with Todoist IDs from your notes into the database. Required for first-time setup if you already have synced tasks. After import, a sync will automatically start.');

		new Setting(containerEl)
			.setName('Completed Tasks Lookback')
			.setDesc('Days to look back when fetching completed tasks during migration (max: 90)')
			.addText(text => text
				.setPlaceholder('90')
				.setValue(String(this.plugin.settings.completedTasksLookbackDays))
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num) && num >= 0) {
						// Cap at 90 days (Todoist API 3-month limit)
						this.plugin.settings.completedTasksLookbackDays = Math.min(num, 90);
						await this.plugin.saveSettings();
						// Update display if capped
						if (num > 90) {
							text.setValue('90');
						}
					}
				}));

		new Setting(containerEl)
			.setName('Import Existing Tasks')
			.setDesc('Scan all files with frontmatter and import tasks. Automatically syncs after import.')
			.addButton(button => button
				.setButtonText('Import Tasks')
				.setDisabled(!this.plugin.settings.apiInitialized)
				.onClick(async () => {
					// Show confirmation modal
					new MigrationConfirmModal(this.app, this.plugin, async () => {
						await this.plugin.runMigration();
					}).open();
				}));

		if (!this.plugin.settings.apiInitialized) {
			containerEl.createEl('p', {
				text: 'Note: Configure API token and test connection before running migration.',
				cls: 'setting-item-description mod-warning'
			});
		}

		// API Token section
		containerEl.createEl('h3', { text: 'Authentication' });

		new Setting(containerEl)
			.setName('Todoist API Token')
			.setDesc('Your Todoist API token from Settings > Integrations')
			.addText(text => text
				.setPlaceholder('Enter API token')
				.setValue(this.plugin.settings.todoistAPIToken)
				.onChange(async (value) => {
					this.plugin.settings.todoistAPIToken = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Test Connection')
			.setDesc('Test your API token and fetch user data')
			.addButton(button => button
				.setButtonText('Test Connection')
				.onClick(async () => {
					await this.plugin.testAPIConnection();
				}));

		// Scheduled Sync section
		containerEl.createEl('h3', { text: 'Scheduled Sync' });

		new Setting(containerEl)
			.setName('Enable Scheduled Sync')
			.setDesc('Automatically sync every N seconds (disabled by default)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enableScheduledSync)
				.onChange(async (value) => {
					this.plugin.settings.enableScheduledSync = value;
					await this.plugin.saveSettings();
					// Restart sync interval with new setting
					this.plugin.restartScheduledSync();
				}));

		new Setting(containerEl)
			.setName('Sync Interval')
			.setDesc('Seconds between syncs (minimum: 20, default: 60)')
			.addText(text => text
				.setPlaceholder('60')
				.setValue(String(this.plugin.settings.syncInterval))
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num) && num >= 20) {
						this.plugin.settings.syncInterval = num;
						await this.plugin.saveSettings();
						// Restart sync interval with new setting
						this.plugin.restartScheduledSync();
					}
				}));

		// Default Project section
		containerEl.createEl('h3', { text: 'Default Project' });

		new Setting(containerEl)
			.setName('Default Project')
			.setDesc('Default project for new tasks (fetched from Todoist)')
			.addDropdown(dropdown => {
				// Populate dropdown with projects
				if (this.plugin.settings.projects.length > 0) {
					this.plugin.settings.projects.forEach(project => {
						dropdown.addOption(project.id, project.name);
					});
					dropdown.setValue(this.plugin.settings.defaultProjectId);
				} else {
					// No projects loaded yet
					dropdown.addOption('', 'No projects loaded');
					dropdown.setDisabled(true);
				}

				dropdown.onChange(async (value) => {
					const selectedProject = this.plugin.settings.projects.find(p => p.id === value);
					if (selectedProject) {
						this.plugin.settings.defaultProjectId = selectedProject.id;
						this.plugin.settings.defaultProjectName = selectedProject.name;
						await this.plugin.saveSettings();
					}
				});
			});

		// Conflict Resolution section
		containerEl.createEl('h3', { text: 'Conflict Resolution' });

		new Setting(containerEl)
			.setName('Conflict Resolution Window')
			.setDesc('Seconds (+/-). Positive: API wins, Negative: Local wins')
			.addText(text => text
				.setPlaceholder('60')
				.setValue(String(this.plugin.settings.conflictResolutionWindow))
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num)) {
						this.plugin.settings.conflictResolutionWindow = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setDesc('If timestamps are within this window: positive value means Todoist wins, negative means local file wins')
			.setClass('setting-item-description');

		// User Info section (display only)
		if (this.plugin.settings.apiInitialized) {
			containerEl.createEl('h3', { text: 'User Information' });

			new Setting(containerEl)
				.setName('Email')
				.setDesc(this.plugin.settings.userData.email)
				.setDisabled(true);

			new Setting(containerEl)
				.setName('Full Name')
				.setDesc(this.plugin.settings.userData.full_name)
				.setDisabled(true);

			new Setting(containerEl)
				.setName('Timezone')
				.setDesc(this.plugin.settings.userData.tz_info.timezone)
				.setDisabled(true);
		}
	}
}

/**
 * Confirmation modal for migration operation.
 * Shows detailed explanation and requires explicit confirmation.
 */
class MigrationConfirmModal extends Modal {
	plugin: TodoistSyncPlugin;
	onConfirm: () => void;

	constructor(app: App, plugin: TodoistSyncPlugin, onConfirm: () => void) {
		super(app);
		this.plugin = plugin;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Import Existing Tasks?' });

		contentEl.createEl('p', {
			text: 'This will scan all files with "todoist-sync: true" frontmatter and import tasks that have Todoist IDs.'
		});

		contentEl.createEl('p', { text: 'Requirements:' });
		const ul = contentEl.createEl('ul');
		ul.createEl('li', { text: 'Database must be empty' });
		ul.createEl('li', { text: 'Tasks must have existing Todoist IDs (%%[tid:: ...]%%)' });

		contentEl.createEl('p', {
			text: 'After migration completes, a sync will automatically start. This ensures completed tasks are fetched and all changes from Todoist are reconciled.'
		});

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

		buttonContainer.createEl('button', { text: 'Cancel' })
			.addEventListener('click', () => this.close());

		buttonContainer.createEl('button', {
			text: 'Import',
			cls: 'mod-cta'
		}).addEventListener('click', () => {
			this.close();
			this.onConfirm();
		});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
