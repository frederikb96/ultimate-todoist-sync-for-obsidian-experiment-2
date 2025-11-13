import { Plugin } from 'obsidian';

export default class TodoistSyncPlugin extends Plugin {
	async onload() {
		console.log('Todoist Sync 2.0 - Plugin loaded');
	}

	async onunload() {
		console.log('Todoist Sync 2.0 - Plugin unloaded');
	}
}
