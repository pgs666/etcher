const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const packageDir = path.join(process.cwd(), 'out', 'balenaEtcher-win32-arm64');
const sidecarPath = path.join(packageDir, 'resources', 'etcher-util.exe');
const testImagePath = path.join(
	process.cwd(),
	'out',
	'windows-arm64-write-diagnostics.img',
);
const port = '45679';
const missingDevice = '\\\\.\\PhysicalDrive99999';

function tail(value) {
	return value.split(/\r?\n/).slice(-80).join('\n');
}

function connectWebSocket(url, timeoutMs) {
	const started = Date.now();

	return new Promise((resolve, reject) => {
		const attempt = () => {
			const ws = new WebSocket(url);
			let settled = false;

			ws.once('open', () => {
				settled = true;
				resolve(ws);
			});

			ws.once('error', (error) => {
				if (settled) {
					reject(error);
					return;
				}

				ws.close();
				if (Date.now() - started > timeoutMs) {
					reject(error);
					return;
				}

				setTimeout(attempt, 250);
			});
		};

		attempt();
	});
}

function send(ws, type, payload) {
	ws.send(JSON.stringify({ type, payload }));
}

function waitForMessage(ws, type, timeoutMs, onExpectedFail) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			ws.off('message', onMessage);
			reject(new Error(`Timed out waiting for ${type}`));
		}, timeoutMs);

		const onMessage = (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === 'error' || message.type === 'fail') {
				if (message.type === 'fail' && onExpectedFail) {
					onExpectedFail(message.payload);
					return;
				}

				clearTimeout(timeout);
				ws.off('message', onMessage);
				reject(new Error(`${message.type}: ${JSON.stringify(message.payload)}`));
				return;
			}

			if (message.type === type) {
				clearTimeout(timeout);
				ws.off('message', onMessage);
				resolve(message);
			}
		};

		ws.on('message', onMessage);
	});
}

function parsePayload(message) {
	return typeof message.payload === 'string'
		? JSON.parse(message.payload)
		: message.payload;
}

function getDiagnosticMessage(payload) {
	const error = payload.error || payload;
	return error.message || '';
}

function assertDiagnosticError(payload) {
	const message = getDiagnosticMessage(payload);
	for (const snippet of [
		"Couldn't clean the drive",
		'killed: false',
		'command: diskpart',
		'select disk 99999',
		'clean',
		'rescan',
	]) {
		if (!message.includes(snippet)) {
			throw new Error(`Missing diagnostic snippet "${snippet}" in: ${message}`);
		}
	}
}

async function main() {
	fs.writeFileSync(testImagePath, Buffer.alloc(1024 * 1024));

	const child = childProcess.spawn(sidecarPath, {
		env: {
			...process.env,
			ETCHER_TERMINATE_TIMEOUT: '30000',
			ETCHER_SERVER_PORT: port,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let stdout = '';
	let stderr = '';
	let failPayload;
	child.stdout.on('data', (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on('data', (chunk) => {
		stderr += chunk.toString();
	});

	let ws;
	try {
		ws = await connectWebSocket(`ws://127.0.0.1:${port}`, 15000);
		const ready = waitForMessage(ws, 'ready', 5000);

		send(ws, 'ready');
		await ready;
		send(ws, 'heartbeat');

		const done = waitForMessage(ws, 'done', 30000, (payload) => {
			failPayload = payload;
		});
		send(ws, 'write', {
			SourceType: 'File',
			autoBlockmapping: true,
			decompressFirst: true,
			image: {
				path: testImagePath,
				size: 1024 * 1024,
				name: path.basename(testImagePath),
				extension: 'img',
				hasMBR: false,
			},
			destinations: [
				{
					device: missingDevice,
					raw: missingDevice,
					description: 'Missing Windows ARM64 smoke device',
					displayName: missingDevice,
					size: 1024 * 1024,
					blockSize: 512,
					logicalBlockSize: 512,
					isReadOnly: false,
					isSystem: false,
					isVirtual: false,
					isRemovable: true,
					isUSB: true,
					mountpoints: [],
				},
			],
		});
		const donePayload = parsePayload(await done);
		const errors = donePayload.results && donePayload.results.errors;
		if (!Array.isArray(errors) || errors.length !== 1) {
			throw new Error(
				`Unexpected write done payload: ${JSON.stringify(donePayload)}`,
			);
		}
		if (failPayload === undefined) {
			throw new Error('Missing expected fail event before write done event');
		}
		assertDiagnosticError(failPayload);
		assertDiagnosticError(errors[0]);
	} catch (error) {
		child.kill();
		throw error;
	} finally {
		if (ws) {
			ws.close();
		}
	}

	const exitCode = await new Promise((resolve) => {
		child.on('exit', (code, signal) => resolve(code ?? signal));
	});

	if (exitCode !== 1) {
		console.log('Sidecar stdout tail:');
		console.log(tail(stdout));
		console.log('Sidecar stderr tail:');
		console.log(tail(stderr));
		throw new Error(
			`Expected sidecar write diagnostics smoke to exit with 1, got ${exitCode}`,
		);
	}

	console.log('Verified write failure includes diskpart diagnostics');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
