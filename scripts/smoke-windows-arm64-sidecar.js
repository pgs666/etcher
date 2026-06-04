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
		ws.on('message', () => undefined);

		send(ws, 'ready');
		send(ws, 'heartbeat');
		send(ws, 'scan');
		send(
			ws,
			'sourceMetadata',
			JSON.stringify({
				selected: testImagePath,
				SourceType: 'File',
			}),
		);

		await wait(2000);
		send(ws, 'terminate');
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

	if (exitCode !== 0) {
		console.log('Sidecar stdout tail:');
		console.log(tail(stdout));
		console.log('Sidecar stderr tail:');
		console.log(tail(stderr));
		throw new Error(`Sidecar smoke test failed with exit code ${exitCode}`);
	}

	console.log(
		'Verified sidecar WebSocket, scan, source metadata, and terminate paths',
	);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
