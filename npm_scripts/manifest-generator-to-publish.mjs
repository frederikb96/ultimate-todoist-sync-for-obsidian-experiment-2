// Script under constructions - Non-functional yet.

import fs from "fs";
import path from "path";

// Helper function to read JSON file
const readJsonFile = (filePath) => {
	try {
		const fileContent = fs.readFileSync(filePath, "utf8");
		return JSON.parse(fileContent);
	} catch (error) {
		console.error(
			`Error reading or parsing JSON file at ${filePath}:`,
			error.message
		);
		throw error;
	}
};

// Helper function to write JSON file
const writeJsonFile = (filePath, data) => {
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
};

// Function to update the version
const updateVersion = (currentVersion, major, minor, patch) => {
	const [baseVersion] = currentVersion.split("+");
	const [majorVersion, minorVersion, patchVersion] = baseVersion
		.split(".")
		.map(Number);

	const newMajor = major !== undefined ? majorVersion + major : majorVersion;
	const newMinor = minor !== undefined ? minorVersion + minor : minorVersion;
	const newPatch = patch !== undefined ? patchVersion + patch : patchVersion;

	const newBaseVersion = `${newMajor}.${newMinor}.${newPatch}`;
	// const newBuildMetadata = new Date()
	// 	.toISOString()
	// 	.replace(/[-:T]/g, "")
	// 	.slice(0, 12);

	console.log("newBaseVersion = " + newBaseVersion);

	return `${newBaseVersion}`;
};

// Main function
const main = () => {
	const rootDir = path.dirname(process.argv[1]);

	const upperFolderPath = path.join(rootDir, "/../");

	console.log("rootDir = " + rootDir);
	console.log("upperFolderPath = " + upperFolderPath);

	const manifestPath = path.join(upperFolderPath, "manifest.json");
	// const versionsPath = path.join(rootDir, "versions.json");

	const manifest = readJsonFile(manifestPath);
	// const versions = readJsonFile(versionsPath);

	const [, , major, minor, patch] = process.argv.map((arg) =>
		arg !== undefined ? parseInt(arg, 10) : undefined
	);

	const newVersion = updateVersion(manifest.version, major, minor, patch);

	manifest.version = newVersion;
	writeJsonFile(manifestPath, manifest);

	// versions.push({
	// 	version: newVersion,
	// 	minAppVersion: manifest.minAppVersion,
	// });
	// writeJsonFile(versionsPath, versions);

	console.log(`Updated manifest.json to version ${newVersion}`);
	console.log(
		`Updated versions.json with version ${newVersion} and minAppVersion ${manifest.minAppVersion}`
	);
};

main();
