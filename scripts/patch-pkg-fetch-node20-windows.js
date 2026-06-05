#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const pkgFetchDir = path.dirname(
	require.resolve('@yao-pkg/pkg-fetch/package.json'),
);
const expectedShasPath = path.join(
	pkgFetchDir,
	'lib-es5',
	'expected-shas.json',
);
const patchesPath = path.join(pkgFetchDir, 'patches', 'patches.json');

const expectedShas = JSON.parse(fs.readFileSync(expectedShasPath, 'utf8'));

Object.assign(expectedShas, {
	'node-v20.11.1-win-arm64':
		'b99c38987104b066fbdc5e1c121fc8386217eeea7ffcadc7ec035532e7ea9789',
	'node-v20.11.1-win-x64':
		'140c377c2c91751832e673cb488724cbd003f01aa237615142cd2907f34fa1a2',
});

fs.writeFileSync(
	expectedShasPath,
	`${JSON.stringify(expectedShas, null, 2)}\n`,
);

const patches = JSON.parse(fs.readFileSync(patchesPath, 'utf8'));

for (const key of Object.keys(patches)) {
	if (/^v20\./.test(key) && key !== 'v20.11.1') {
		delete patches[key];
	}
}

patches['v20.11.1'] = ['node.v20.11.1.cpp.patch'];

fs.writeFileSync(patchesPath, `${JSON.stringify(patches, null, 2)}\n`);
