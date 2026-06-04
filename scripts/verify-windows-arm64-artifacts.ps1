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

$packageDir = Get-ChildItem -Path out -Directory -Filter 'balenaEtcher-win32-arm64' | Select-Object -First 1
if ($null -eq $packageDir) {
	throw 'Missing packaged app directory out/balenaEtcher-win32-arm64'
}

$resourcesDir = Join-Path $packageDir.FullName 'resources'
$nativeModulesDir = Join-Path $resourcesDir 'app.asar.unpacked'
$sidecarPath = Join-Path $resourcesDir 'etcher-util.exe'

Assert-Arm64Pe -Path (Join-Path $packageDir.FullName 'balenaEtcher.exe')
Assert-Arm64Pe -Path $sidecarPath

$matchedNativeModules = Get-ChildItem -Path $nativeModulesDir -Recurse -File -Filter '*.node' -ErrorAction SilentlyContinue
if ($null -eq $matchedNativeModules -or $matchedNativeModules.Count -eq 0) {
	throw "No native modules found under $nativeModulesDir"
}

foreach ($module in ($matchedNativeModules | Sort-Object FullName -Unique)) {
	Assert-Arm64Pe -Path $module.FullName
}

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

$distFiles = Get-ChildItem -Path out/make -Recurse -File -Include '*.zip', '*Setup.exe'
if ($distFiles.Count -lt 2) {
	throw 'Expected both zip and Squirrel Setup.exe distributables'
}

$distFiles | ForEach-Object { Write-Host "Found distributable: $($_.FullName)" }
