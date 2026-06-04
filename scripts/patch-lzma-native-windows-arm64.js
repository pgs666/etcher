#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

if (process.platform !== 'win32' || process.arch !== 'arm64') {
	process.exit(0);
}

const moduleDir = path.dirname(require.resolve('lzma-native/package.json'));
const bindingPath = path.join(moduleDir, 'binding.gyp');
const vcpkgRoot = process.env.VCPKG_INSTALLATION_ROOT || 'C:\\vcpkg';
const vcpkgTriplet = process.env.VCPKG_DEFAULT_TRIPLET || 'arm64-windows';
const vcpkgInstalled = path
	.join(vcpkgRoot, 'installed', vcpkgTriplet)
	.replace(/\\/g, '\\\\');

let binding = fs.readFileSync(bindingPath, 'utf8');

binding = binding.replace(
	`"include_dirs" : [ "<(module_root_dir)\\\\deps\\\\include" ],
          "link_settings": {
            "libraries" : [ "-llzma" ],
            "conditions": [
              [ 'target_arch=="x64"', {
                "library_dirs" : [ "<(module_root_dir)\\\\deps\\\\bin_x86-64" ]
              }, {
                "library_dirs" : [ "<(module_root_dir)\\\\deps\\\\bin_i686" ]
              } ]
            ]
          }`,
	`"conditions": [
            [ 'target_arch=="arm64"', {
              "include_dirs" : [ "${vcpkgInstalled}\\\\include" ],
              "link_settings": {
                "libraries" : [ "-llzma" ],
                "library_dirs" : [ "${vcpkgInstalled}\\\\lib" ]
              }
            }, {
              "include_dirs" : [ "<(module_root_dir)\\\\deps\\\\include" ],
              "link_settings": {
                "libraries" : [ "-llzma" ],
                "conditions": [
                  [ 'target_arch=="x64"', {
                    "library_dirs" : [ "<(module_root_dir)\\\\deps\\\\bin_x86-64" ]
                  }, {
                    "library_dirs" : [ "<(module_root_dir)\\\\deps\\\\bin_i686" ]
                  } ]
                ]
              }
            } ]
          ]`,
);

binding = binding.replace(
	`[ 'target_arch=="x64"', {
              'variables': {
                "arch_lib_path" : 'bin_x86-64',
                "arch_lib_code" : 'x64'
              }
            }, {
              'variables': {
                "arch_lib_path" : 'bin_i686',
                "arch_lib_code" : 'ix86'
              }
            } ]`,
	`[ 'target_arch=="arm64"', {
              'variables': {
                "arch_lib_path" : '${vcpkgInstalled}\\\\bin',
                "arch_lib_code" : 'arm64'
              }
            }, {
              "conditions": [
                [ 'target_arch=="x64"', {
                  'variables': {
                    "arch_lib_path" : 'bin_x86-64',
                    "arch_lib_code" : 'x64'
                  }
                }, {
                  'variables': {
                    "arch_lib_path" : 'bin_i686',
                    "arch_lib_code" : 'ix86'
                  }
                } ]
              ]
            } ]`,
);

binding = binding.replace(
	`'action': ['lib.exe -def:"<(module_root_dir)/deps/doc/liblzma.def" -out:"<(module_root_dir)/deps/<(arch_lib_path)/lzma.lib" -machine:<(arch_lib_code)']`,
	`'action': ['if "<(arch_lib_code)"=="arm64" ( echo Using vcpkg liblzma import library ) else ( lib.exe -def:"<(module_root_dir)/deps/doc/liblzma.def" -out:"<(module_root_dir)/deps/<(arch_lib_path)/lzma.lib" -machine:<(arch_lib_code) )']`,
);

binding = binding.replace(
	`'inputs': ['deps/<(arch_lib_path)/liblzma.dll'],
              'outputs': ['<(dlldir)/liblzma.dll'],
              'action': ['mkdir <(dlldir) > nul 2>&1 & copy "<(module_root_dir)/deps/<(arch_lib_path)/liblzma.dll" <(dlldir)/liblzma.dll']`,
	`'inputs': [],
              'outputs': ['<(dlldir)/liblzma.dll'],
              'action': ['mkdir <(dlldir) > nul 2>&1 & if "<(arch_lib_code)"=="arm64" ( copy "<(arch_lib_path)/lzma.dll" <(dlldir)/liblzma.dll ) else ( copy "<(module_root_dir)/deps/<(arch_lib_path)/liblzma.dll" <(dlldir)/liblzma.dll )']`,
);

fs.writeFileSync(bindingPath, binding);
