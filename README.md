# Another Even Simpler Todoist Sync

Dead-simple bidirectional sync between Obsidian and Todoist.

## Features

- **Frontmatter control**: Add `todoist-sync: true` to notes, all tasks sync automatically
- **Reliable queue system**: DB-centric architecture with conflict resolution
- **Active file handling**: Preserves cursor position during edits
- **Migration button**: Import existing tasks with one click

## Installation

```bash
# Clone and build
git clone https://github.com/frederikb96/obsidian-todoist-helper.git
cd obsidian-todoist-helper
npm install
npm run build

# Install to Obsidian
cp main.js manifest.json styles.css ~/path/to/vault/.obsidian/plugins/another-simple-todoist-sync/
```

## Setup

1. Enable plugin in Obsidian settings
2. Add Todoist API token (Settings → Integrations → Developer)
3. Test connection
4. Optional: Run migration if you have existing tasks with IDs
5. Add `todoist-sync: true` to note frontmatter
6. Create tasks with `- [ ] Task text` - sync happens automatically

## Configuration

- **Scheduled sync**: Optional background sync (default: off)
- **Conflict resolution**: Configure which source wins (API vs local)
- **Default project**: Set default Todoist project for new tasks

## License

GNU GPLv3
