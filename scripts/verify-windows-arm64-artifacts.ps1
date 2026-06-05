$ErrorActionPreference = 'Stop'

function Get-PeMachine {
	Param([Parameter(Mandatory = $true)][string]$Path)

	$stream = [System.IO.File]::OpenRead($Path)
	try {
		$reader = New-Object System.IO.BinaryReader($stream)

		if ($reader.ReadUInt16() -ne 0x5A4D) {
			throw "Not a PE file: $Path"
		}

		$stream.Seek(0x3C, [System.IO.SeekOrigin]::Begin) | Out-Null
		$peOffset = $reader.ReadUInt32()
		$stream.Seek($peOffset, [System.IO.SeekOrigin]::Begin) | Out-Null

		if ($reader.ReadUInt32() -ne 0x00004550) {
			throw "Invalid PE signature: $Path"
		}

		return $reader.ReadUInt16()
	} finally {
		$stream.Dispose()
	}
}

function Assert-Arm64Pe {
	Param([Parameter(Mandatory = $true)][string]$Path)

	if (-not (Test-Path -LiteralPath $Path)) {
		throw "Missing expected artifact: $Path"
	}

	$machine = Get-PeMachine -Path $Path
	if ($machine -ne 0xAA64) {
		throw ("Expected ARM64 PE machine 0xAA64 for $Path, got 0x{0:X4}" -f $machine)
	}

	Write-Host "Verified ARM64 PE: $Path"
}

function Assert-PeMachine {
	Param(
		[Parameter(Mandatory = $true)][string]$Path,
		[Parameter(Mandatory = $true)][int]$ExpectedMachine,
		[Parameter(Mandatory = $true)][string]$Description
	)

	if (-not (Test-Path -LiteralPath $Path)) {
		throw "Missing expected artifact: $Path"
	}

	$machine = Get-PeMachine -Path $Path
	if ($machine -ne $ExpectedMachine) {
		throw ("Expected $Description PE machine 0x{0:X4} for $Path, got 0x{1:X4}" -f $ExpectedMachine, $machine)
	}

	Write-Host ("Verified {0} PE: {1}" -f $Description, $Path)
}

function Assert-Exists {
	Param([Parameter(Mandatory = $true)][string]$Path)

	if (-not (Test-Path -LiteralPath $Path)) {
		throw "Missing expected artifact: $Path"
	}
}

function Assert-BinaryContainsAscii {
	Param(
		[Parameter(Mandatory = $true)][string]$Path,
		[Parameter(Mandatory = $true)][string]$Text
	)

	if (-not (Test-Path -LiteralPath $Path)) {
		throw "Missing expected artifact: $Path"
	}

	$bytes = [System.IO.File]::ReadAllBytes($Path)
	$content = [System.Text.Encoding]::ASCII.GetString($bytes)
	if ($content.Contains($Text)) {
		Write-Host "Verified binary contains '$Text': $Path"
		return
	}

	throw "Expected binary to contain '$Text': $Path"
}

function Assert-SidecarDiagnostics {
	Param([Parameter(Mandatory = $true)][string]$Path)

	Assert-BinaryContainsAscii -Path $Path -Text "Couldn't clean the drive"
	Assert-BinaryContainsAscii -Path $Path -Text 'stdout:\n${error.stdout}'
	Assert-BinaryContainsAscii -Path $Path -Text 'stderr:\n${error.stderr}'
	Assert-BinaryContainsAscii -Path $Path -Text 'script:\n${error.script}'
}

function Assert-Arm64PackagePeFiles {
	Param(
		[Parameter(Mandatory = $true)][string]$Path,
		[Parameter(Mandatory = $true)][string]$Description
	)

	$peFiles = Get-ChildItem -Path $Path -Recurse -File -Include '*.exe', '*.dll', '*.node' -ErrorAction SilentlyContinue
	if ($null -eq $peFiles -or $peFiles.Count -eq 0) {
		throw "No PE files found under $Path"
	}

	foreach ($file in ($peFiles | Sort-Object FullName -Unique)) {
		if ($file.Name -eq 'Squirrel.exe' -or $file.Name -like '*_ExecutionStub.exe') {
			Assert-PeMachine -Path $file.FullName -ExpectedMachine 0x014C -Description "$Description Squirrel helper x86"
			continue
		}

		Assert-Arm64Pe -Path $file.FullName
	}
}

$packageDir = Get-ChildItem -Path out -Directory -Filter 'balenaEtcher-win32-arm64' | Select-Object -First 1
if ($null -eq $packageDir) {
	throw 'Missing packaged app directory out/balenaEtcher-win32-arm64'
}

$packageJson = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
$resourcesDir = Join-Path $packageDir.FullName 'resources'
$nativeModulesDir = Join-Path $resourcesDir 'app.asar.unpacked'
$sidecarPath = Join-Path $resourcesDir 'etcher-util.exe'
$lzmaPath = Join-Path $resourcesDir 'liblzma.dll'

$nativeModules = Get-ChildItem -Path $nativeModulesDir -Recurse -File -Filter '*.node' -ErrorAction SilentlyContinue
if ($null -eq $nativeModules -or $nativeModules.Count -eq 0) {
	throw "No native modules found under $nativeModulesDir"
}

Assert-Arm64PackagePeFiles -Path $packageDir.FullName -Description 'packaged app'
Assert-Arm64Pe -Path $lzmaPath
Assert-SidecarDiagnostics -Path $sidecarPath

$previousTerminateTimeout = $env:ETCHER_TERMINATE_TIMEOUT
$previousServerPort = $env:ETCHER_SERVER_PORT
try {
	$env:ETCHER_TERMINATE_TIMEOUT = '1000'
	$env:ETCHER_SERVER_PORT = '45678'
	$stdoutPath = Join-Path $env:RUNNER_TEMP 'etcher-util.stdout.log'
	$stderrPath = Join-Path $env:RUNNER_TEMP 'etcher-util.stderr.log'
	$process = Start-Process -FilePath $sidecarPath -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
	if ($process.ExitCode -ne 0) {
		Write-Host "Sidecar stdout tail:"
		Get-Content -LiteralPath $stdoutPath -Tail 40 -ErrorAction SilentlyContinue
		Write-Host "Sidecar stderr tail:"
		Get-Content -LiteralPath $stderrPath -Tail 40 -ErrorAction SilentlyContinue
		throw "Sidecar smoke test failed with exit code $($process.ExitCode)"
	}
	Write-Host 'Verified sidecar starts and exits cleanly'
} finally {
	$env:ETCHER_TERMINATE_TIMEOUT = $previousTerminateTimeout
	$env:ETCHER_SERVER_PORT = $previousServerPort
}

$squirrelDir = Get-ChildItem -Path out/make -Directory -Recurse -Filter 'arm64' |
	Where-Object { $_.FullName -like '*squirrel.windows*' } |
	Select-Object -First 1
if ($null -eq $squirrelDir) {
	throw 'Missing Squirrel Windows ARM64 output directory'
}

$setupExe = Join-Path $squirrelDir.FullName "balenaEtcher-$($packageJson.version) Setup.exe"
$releasesFile = Join-Path $squirrelDir.FullName 'RELEASES'
$fullNupkg = Get-ChildItem -Path $squirrelDir.FullName -File -Filter '*-full.nupkg' | Select-Object -First 1

Assert-PeMachine -Path $setupExe -ExpectedMachine 0x014C -Description 'Squirrel setup bootstrapper x86'
Assert-Exists -Path $releasesFile
if ($null -eq $fullNupkg) {
	throw "Missing Squirrel full nupkg under $($squirrelDir.FullName)"
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$nupkgExtractDir = Join-Path $tempRoot 'etcher-arm64-full-nupkg'
$nupkgZipPath = Join-Path $tempRoot 'etcher-arm64-full-nupkg.zip'
Remove-Item -LiteralPath $nupkgExtractDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $nupkgZipPath -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $fullNupkg.FullName -Destination $nupkgZipPath
Expand-Archive -LiteralPath $nupkgZipPath -DestinationPath $nupkgExtractDir -Force
Assert-Arm64PackagePeFiles -Path $nupkgExtractDir -Description 'Squirrel full nupkg'
Assert-Arm64Pe -Path (Join-Path $nupkgExtractDir 'lib/net45/resources/liblzma.dll')
Assert-SidecarDiagnostics -Path (Join-Path $nupkgExtractDir 'lib/net45/resources/etcher-util.exe')

$zipFile = Get-ChildItem -Path out/make/zip/win32/arm64 -File -Filter '*.zip' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $zipFile) {
	throw 'Missing Windows ARM64 zip distributable'
}

$zipExtractDir = Join-Path $tempRoot 'etcher-arm64-zip'
Remove-Item -LiteralPath $zipExtractDir -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $zipFile.FullName -DestinationPath $zipExtractDir -Force
Assert-Arm64PackagePeFiles -Path $zipExtractDir -Description 'zip distributable'
Assert-Arm64Pe -Path (Join-Path $zipExtractDir 'resources/liblzma.dll')
Assert-SidecarDiagnostics -Path (Join-Path $zipExtractDir 'resources/etcher-util.exe')

Write-Host "Found distributable: $setupExe"
Write-Host "Found distributable: $($zipFile.FullName)"
Write-Host "Found Squirrel RELEASES: $releasesFile"
Write-Host "Found Squirrel full package: $($fullNupkg.FullName)"
