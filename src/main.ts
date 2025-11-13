import { Plugin } from 'obsidian';
import { SyncSettings } from './types';
import { DEFAULT_SETTINGS, Database } from './database';
import { TodoistSettingTab } from './settings';

export default class TodoistSyncPlugin extends Plugin {
	settings: SyncSettings;
	db: Database;

	async onload() {
		console.log('Todoist Sync 2.0 - Loading');

		// Load settings from data.json
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.db = new Database(this.settings);

		// Add settings tab
		this.addSettingTab(new TodoistSettingTab(this.app, this));

		console.log('Todoist Sync 2.0 - Loaded');
	}

	async onunload() {
		await this.saveSettings();
		console.log('Todoist Sync 2.0 - Unloaded');
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
