import { PluginBase } from '@electron-forge/plugin-base';
import type {
	ForgeMultiHookMap,
	ResolvedForgeConfig,
} from '@electron-forge/shared-types';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { DefinePlugin } from 'webpack';

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import debug from 'debug';

const log = debug('sidecar');

function isStartScrpt(): boolean {
	return process.env.npm_lifecycle_event === 'start';
}

function addWebpackDefine(
	config: ResolvedForgeConfig,
	defineName: string,
	binDir: string,
	binName: string,
): ResolvedForgeConfig {
	config.plugins.forEach((plugin) => {
		if (plugin.name !== 'webpack' || !(plugin instanceof WebpackPlugin)) {
			return;
		}

		const { mainConfig } = plugin.config as any;
		if (mainConfig.plugins == null) {
			mainConfig.plugins = [];
		}

		const value = isStartScrpt()
			? // on `npm start`, point directly to the binary
				path.resolve(binDir, binName)
			: // otherwise point relative to the resources folder of the bundled app
				binName;

		log(`define '${defineName}'='${value}'`);

		mainConfig.plugins.push(
			new DefinePlugin({
				// expose path to helper via this webpack define
				[defineName]: JSON.stringify(value),
			}),
		);
	});

	return config;
}

function build(
	sourcesDir: string,
	platform: string,
	buildForArchs: string,
	binDir: string,
	binName: string,
) {
	const commands: Array<[string, string[], object?]> = [
		['tsc', ['--project', 'tsconfig.sidecar.json', '--outDir', sourcesDir]],
	];

	buildForArchs.split(',').forEach((arch) => {
		const binPath = isStartScrpt()
			? // on `npm start`, we don't know the arch we're building for at the time we're
				// adding the webpack define, so we just build under binDir
				path.resolve(binDir, binName)
			: // otherwise build in arch-specific directory within binDir
				path.resolve(binDir, arch, binName);

		// FIXME: rebuilding mountutils shouldn't be necessary, but it is.
		// It's coming from etcher-sdk, a fix has been upstreamed but to use
		// the latest etcher-sdk we need to upgrade axios at the same time.
		commands.push([
			'npx',
			[
				'node-gyp',
				'rebuild',
				`--target=${nativeModuleNodeVersion(platform, arch)}`,
				`--arch=${arch}`,
				`--platform=${platform}`,
			],
			{
				cwd: path.resolve('node_modules', 'mountutils'),
				env: {
					...process.env,
					npm_config_arch: arch,
					npm_config_platform: platform,
					npm_config_runtime: 'node',
					npm_config_target: nativeModuleNodeVersion(platform, arch),
				},
			},
		]);

		commands.push([
			'pkg',
			[
				path.join(sourcesDir, 'util', 'api.js'),
				'-c',
				'pkg-sidecar.json',
				// `--no-bytecode` so that we can cross-compile for arm64 on x64
				'--no-bytecode',
				'--public',
				'--public-packages',
				'"*"',
				// Always build for the Forge target platform and Node version.
				// https://github.com/vercel/pkg-fetch/releases
				'--target',
				`${pkgNodeVersion(platform, arch)}-${pkgPlatform(platform)}-${arch}`,
				'--output',
				binPath,
			],
		]);
	});

	commands.forEach(([cmd, args, opt]) => {
		log('running command:', cmd, args.join(' '));
		execFileSync(cmd, args, { shell: true, stdio: 'inherit', ...opt });
	});
}

function pkgPlatform(platform: string): string {
	if (platform === 'win32') {
		return 'win';
	}

	if (platform === 'darwin') {
		return 'macos';
	}

	return platform;
}

function pkgNodeVersion(platform: string, arch: string): string {
	// pkg's Windows ARM64 Node 20 base binary fails before the sidecar can start.
	// Node 16 is still supported by pkg-fetch and starts cleanly there.
	return platform === 'win32' && arch === 'arm64' ? 'node16' : 'node20';
}

function nativeModuleNodeVersion(platform: string, arch: string): string {
	return platform === 'win32' && arch === 'arm64'
		? '16.20.2'
		: process.versions.node;
}

function copyArtifact(
	buildPath: string,
	platform: string,
	arch: string,
	binDir: string,
	binName: string,
) {
	const binPath = isStartScrpt()
		? // on `npm start`, we don't know the arch we're building for at the time we're
			// adding the webpack define, so look for the binary directly under binDir
			path.resolve(binDir, binName)
		: // otherwise look into arch-specific directory within binDir
			path.resolve(binDir, arch, binName);

	// buildPath points to appPath, which is inside resources dir which is the one we actually want
	const resourcesPath = path.dirname(buildPath);
	const dest = path.resolve(resourcesPath, path.basename(binPath));
	log(`copying '${binPath}' to '${dest}'`);
	fs.copyFileSync(binPath, dest);

	if (platform === 'win32' && arch === 'arm64') {
		const vcpkgRoot = process.env.VCPKG_INSTALLATION_ROOT || 'C:\\vcpkg';
		const vcpkgTriplet = process.env.VCPKG_DEFAULT_TRIPLET || 'arm64-windows';
		const lzmaDll = path.join(
			vcpkgRoot,
			'installed',
			vcpkgTriplet,
			'bin',
			'liblzma.dll',
		);
		const lzmaDest = path.resolve(resourcesPath, 'liblzma.dll');
		log(`copying '${lzmaDll}' to '${lzmaDest}'`);
		fs.copyFileSync(lzmaDll, lzmaDest);
	}
}

export class SidecarPlugin extends PluginBase<void> {
	name = 'sidecar';

	constructor() {
		super();
		this.getHooks = this.getHooks.bind(this);
		log('isStartScript:', isStartScrpt());
	}

	getHooks(): ForgeMultiHookMap {
		const DEFINE_NAME = 'ETCHER_UTIL_BIN_PATH';
		const BASE_DIR = path.join('out', 'sidecar');
		const SRC_DIR = path.join(BASE_DIR, 'src');
		const BIN_DIR = path.join(BASE_DIR, 'bin');
		const BIN_NAME = `etcher-util${process.platform === 'win32' ? '.exe' : ''}`;

		return {
			resolveForgeConfig: async (currentConfig) => {
				log('resolveForgeConfig');
				return addWebpackDefine(currentConfig, DEFINE_NAME, BIN_DIR, BIN_NAME);
			},
			generateAssets: async (_config, platform, arch) => {
				log('generateAssets', { platform, arch });
				build(SRC_DIR, platform, arch, BIN_DIR, BIN_NAME);
			},
			packageAfterCopy: async (
				_config,
				buildPath,
				electronVersion,
				platform,
				arch,
			) => {
				log('packageAfterCopy', {
					buildPath,
					electronVersion,
					platform,
					arch,
				});
				copyArtifact(buildPath, platform, arch, BIN_DIR, BIN_NAME);
			},
		};
	}
}
