#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const diskpartPath = path.join(
	path.dirname(require.resolve('etcher-sdk/package.json')),
	'build',
	'diskpart.js',
);

let diskpart = fs.readFileSync(diskpartPath, 'utf8');

function replaceOnce(source, needle, replacement) {
	if (!source.includes(needle)) {
		throw new Error(
			`Unable to patch etcher-sdk diskpart.js; missing: ${needle}`,
		);
	}

	return source.replace(needle, replacement);
}

if (diskpart.includes('Subclass to capture output from command execution.')) {
	console.log('etcher-sdk diskpart logging patch already applied');
	process.exit(0);
}

diskpart = replaceOnce(
	diskpart,
	`/** Subclass to capture stdout from command execution. */
class ExecError extends Error {
    constructor(message, stdout) {
        super(message);
        this.name = 'ExecError';
        this.stdout = stdout;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}`,
	`/** Subclass to capture output from command execution. */
class ExecError extends Error {
    constructor(message, stdout, stderr, code) {
        super(message);
        this.name = 'ExecError';
        this.stdout = stdout;
        this.stderr = stderr;
        this.code = code;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}`,
);

diskpart = replaceOnce(
	diskpart,
	`if (error) {
                reject(new ExecError(error.message, stdout));
            }`,
	`if (error) {
                reject(new ExecError(error.message, stdout, stderr, error.code));
            }`,
);

diskpart = replaceOnce(
	diskpart,
	`let output = { stdout: '', stderr: '' };
    await (0, tmp_1.withTmpFile)({ keepOpen: false }, async (file) => {
        await fs_1.promises.writeFile(file.path, commands.join('\\r\\n'));`,
	`let output = { stdout: '', stderr: '' };
    await (0, tmp_1.withTmpFile)({ keepOpen: false }, async (file) => {
        const script = commands.join('\\r\\n');
        await fs_1.promises.writeFile(file.path, script);`,
);

diskpart = replaceOnce(
	diskpart,
	`output = await execFileAsync('diskpart', ['/s', file.path]);
            debug('stdout:', output.stdout);
            debug('stderr:', output.stderr);`,
	`try {
                output = await execFileAsync('diskpart', ['/s', file.path]);
            }
            catch (error) {
                error.script = script;
                throw error;
            }
            debug('stdout:', output.stdout);
            debug('stderr:', output.stderr);`,
);

diskpart = replaceOnce(
	diskpart,
	`throw new Error(\`Couldn't clean the drive, \${error.message} (code \${error.code})\`);`,
	`throw new Error([
                    \`Couldn't clean the drive, \${error.message} (code \${error.code})\`,
                    error.stdout ? \`stdout:\\n\${error.stdout}\` : '',
                    error.stderr ? \`stderr:\\n\${error.stderr}\` : '',
                    error.script ? \`script:\\n\${error.script}\` : '',
                ].filter(Boolean).join('\\n'));`,
);

fs.writeFileSync(diskpartPath, diskpart);
console.log('patched etcher-sdk diskpart clean error logging');
