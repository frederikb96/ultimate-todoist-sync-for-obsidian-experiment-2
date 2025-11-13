// Script under constructions - Non-functional yet.

import fs from "node:fs";
import path from "node:path";

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
const updateVersion = (currentVersion, major, minor, patch, build) => {
	const [baseVersion] = currentVersion.split("+");
	const [majorVersion, minorVersion, patchVersion, buildVersion] = baseVersion
		.split(".")
		.map(Number);

	const newMajor = major !== undefined ? majorVersion + major : majorVersion;
	const newMinor = minor !== undefined ? minorVersion + minor : minorVersion;
	const newPatch = patch !== undefined ? patchVersion + patch : patchVersion;
	let newBuild = build !== undefined ? buildVersion + build : buildVersion;
	if (newBuild === undefined) {
		newBuild = 0;
	}
	newBuild = newBuild + 1;

	const newBaseVersion = `${newMajor}.${newMinor}.${newPatch}.${newBuild}`;
	const newBuildMetadata = new Date(Date.now() - 3 * 60 * 60 * 1000)
		.toISOString()
		.replace(/[-:T]/g, "")
		.slice(0, 12);

	const formattedBuildMetadata = `${newBuildMetadata.slice(
		0,
		8
	)}-${newBuildMetadata.slice(8, 12)}`;

	console.log(`newBaseVersion = ${newBaseVersion}`);
	console.log(`formattedBuildMetadata = ${formattedBuildMetadata}`);
	console.log(`newBuild = ${newBuild}`);

	return `${newBaseVersion}+${formattedBuildMetadata}`;
};

// Main function
const main = () => {
	const rootDir = path.dirname(process.argv[1]);

	const upperFolderPath = path.join(rootDir, "/../");

	console.log(`rootDir = ${rootDir}`);
	console.log(`upperFolderPath = ${upperFolderPath}`);

	const manifestPath = path.join(upperFolderPath, "manifest.json");
	// const versionsPath = path.join(rootDir, "versions.json");

	const manifest = readJsonFile(manifestPath);
	// const versions = readJsonFile(versionsPath);

	const [, , major, minor, patch, build] = process.argv.map((arg) =>
		arg !== undefined ? Number.parseInt(arg, 10) : undefined
	);

	const newVersion = updateVersion(
		manifest.version,
		major,
		minor,
		patch,
		build
	);

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
