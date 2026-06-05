#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const packageDir = path.join(process.cwd(), 'out', 'balenaEtcher-win32-arm64');
const appAsar = path.join(packageDir, 'resources', 'app.asar');
if (!fs.existsSync(appAsar)) {
	throw new Error(`Missing packaged app asar: ${appAsar}`);
}

const entries = asar
	.listPackage(appAsar)
	.map((entry) => entry.replace(/\\/g, '/').replace(/^\/+/, ''));

const iconEntries = entries.filter((entry) =>
	/\.webpack\/renderer\/.*media\/icon\.png$/.test(entry),
);

if (iconEntries.length === 0) {
	const mediaEntries = entries
		.filter((entry) => entry.includes('media/') || entry.endsWith('icon.png'))
		.slice(0, 80)
		.join('\n');
	throw new Error(
		`Missing packaged renderer icon asset in app.asar. Related entries:\n${mediaEntries}`,
	);
}

console.log(`verified packaged icon assets:\n${iconEntries.join('\n')}`);
