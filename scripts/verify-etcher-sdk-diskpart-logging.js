#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const diskpartPath = path.join(
	path.dirname(require.resolve('etcher-sdk/package.json')),
	'build',
	'diskpart.js',
);

const diskpart = fs.readFileSync(diskpartPath, 'utf8');
const expectedSnippets = [
	'this.stderr = stderr;',
	'this.code = code;',
	'const script = commands.join',
	'error.script = script;',
	'stdout:\\n${error.stdout}',
	'stderr:\\n${error.stderr}',
	'script:\\n${error.script}',
];

for (const snippet of expectedSnippets) {
	if (!diskpart.includes(snippet)) {
		throw new Error(
			`etcher-sdk diskpart diagnostic logging patch is missing: ${snippet}`,
		);
	}
}

console.log('verified etcher-sdk diskpart diagnostic logging patch');
