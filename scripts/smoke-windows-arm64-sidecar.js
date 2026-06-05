const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const packageDir = path.join(process.cwd(), 'out', 'balenaEtcher-win32-arm64');
const sidecarPath = path.join(packageDir, 'resources', 'etcher-util.exe');
const testImagePath = path.join(
	process.cwd(),
	'out',
	'windows-arm64-smoke.img',
);
const port = '45678';

function tail(value) {
	return value.split(/\r?\n/).slice(-60).join('\n');
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function waitForMessage(ws, type, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			ws.off('message', onMessage);
			reject(new Error(`Timed out waiting for ${type}`));
		}, timeoutMs);

		const onMessage = (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === 'error' || message.type === 'fail') {
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

function waitForNoError(ws, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			ws.off('message', onMessage);
			resolve();
		}, timeoutMs);

		const onMessage = (data) => {
			const message = JSON.parse(data.toString());
			if (message.type === 'error' || message.type === 'fail') {
				clearTimeout(timeout);
				ws.off('message', onMessage);
				reject(new Error(`${message.type}: ${message.payload}`));
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

function assertSourceMetadata(message) {
	const metadata = parsePayload(message);
	if (metadata.size !== 1024 * 1024) {
		throw new Error(`Unexpected source metadata size: ${metadata.size}`);
	}
	if (metadata.path !== testImagePath) {
		throw new Error(`Unexpected source metadata path: ${metadata.path}`);
	}
	if (metadata.extension !== 'img') {
		throw new Error(`Unexpected source metadata extension: ${metadata.extension}`);
	}
	if (metadata.hasMBR !== false) {
		throw new Error(`Unexpected source metadata hasMBR: ${metadata.hasMBR}`);
	}
}

async function main() {
	fs.writeFileSync(testImagePath, Buffer.alloc(1024 * 1024));

	const child = childProcess.spawn(sidecarPath, {
		env: {
			...process.env,
			ETCHER_TERMINATE_TIMEOUT: '15000',
			ETCHER_SERVER_PORT: port,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	let stdout = '';
	let stderr = '';
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

		const metadata = waitForMessage(ws, 'sourceMetadata', 5000);
		send(
			ws,
			'sourceMetadata',
			JSON.stringify({
				selected: testImagePath,
				SourceType: 'File',
			}),
		);
		assertSourceMetadata(await metadata);

		const nativeModuleSmokeTest = waitForMessage(
			ws,
			'nativeModuleSmokeTest',
			5000,
		);
		send(ws, 'nativeModuleSmokeTest');
		const nativeModuleSmokeTestPayload = parsePayload(
			await nativeModuleSmokeTest,
		);
		if (nativeModuleSmokeTestPayload.mountutils !== true) {
			throw new Error(
				`Unexpected native module smoke test payload: ${JSON.stringify(
					nativeModuleSmokeTestPayload,
				)}`,
			);
		}

		send(ws, 'scan');
		await waitForNoError(ws, 2000);
		send(ws, 'terminate');
	} catch (error) {
		console.log('Sidecar stdout tail:');
		console.log(tail(stdout));
		console.log('Sidecar stderr tail:');
		console.log(tail(stderr));
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

	if (exitCode !== 0) {
		console.log('Sidecar stdout tail:');
		console.log(tail(stdout));
		console.log('Sidecar stderr tail:');
		console.log(tail(stderr));
		throw new Error(`Sidecar smoke test failed with exit code ${exitCode}`);
	}

	console.log(
		'Verified sidecar WebSocket, scan, source metadata, native modules, and terminate paths',
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
