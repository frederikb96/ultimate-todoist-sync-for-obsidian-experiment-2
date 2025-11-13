import { App, PluginSettingTab, Setting } from 'obsidian';
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
					// Will implement in Phase 3 (API client)
					console.log('Test connection - to be implemented');
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
					// Will restart sync interval in Phase 5
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
						// Will restart sync interval in Phase 5
					}
				}));

		// Default Project section
		containerEl.createEl('h3', { text: 'Default Project' });

		new Setting(containerEl)
			.setName('Default Project')
			.setDesc('Default project for new tasks (fetched from Todoist)')
			.addText(text => text
				.setPlaceholder('Inbox')
				.setValue(this.plugin.settings.defaultProjectName)
				.setDisabled(true));

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
