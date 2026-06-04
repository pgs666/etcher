$ErrorActionPreference = 'Stop'

$packageDir = Get-ChildItem -Path out -Directory -Filter 'balenaEtcher-win32-arm64' | Select-Object -First 1
if ($null -eq $packageDir) {
	throw 'Missing packaged app directory out/balenaEtcher-win32-arm64'
}

$appPath = Join-Path $packageDir.FullName 'balenaEtcher.exe'
if (-not (Test-Path -LiteralPath $appPath)) {
	throw "Missing packaged app executable: $appPath"
}

$previousNoSpawnUtil = $env:ETCHER_NO_SPAWN_UTIL
$previousElectronLogging = $env:ELECTRON_ENABLE_LOGGING
$previousElectronConsole = $env:ELECTRON_NO_ATTACH_CONSOLE

$stdoutPath = Join-Path $env:RUNNER_TEMP 'balenaEtcher.stdout.log'
$stderrPath = Join-Path $env:RUNNER_TEMP 'balenaEtcher.stderr.log'

try {
	$env:ETCHER_NO_SPAWN_UTIL = '1'
	$env:ELECTRON_ENABLE_LOGGING = 'true'
	$env:ELECTRON_NO_ATTACH_CONSOLE = 'true'

	$process = Start-Process `
		-FilePath $appPath `
		-ArgumentList '--disable-gpu', '--disable-software-rasterizer' `
		-PassThru `
		-RedirectStandardOutput $stdoutPath `
		-RedirectStandardError $stderrPath

	$deadline = (Get-Date).AddSeconds(30)
	do {
		Start-Sleep -Milliseconds 500
		$process.Refresh()
		if ($process.HasExited) {
			Write-Host 'Application stdout tail:'
			Get-Content -LiteralPath $stdoutPath -Tail 80 -ErrorAction SilentlyContinue
			Write-Host 'Application stderr tail:'
			Get-Content -LiteralPath $stderrPath -Tail 80 -ErrorAction SilentlyContinue
			throw "Application exited before creating a window with exit code $($process.ExitCode)"
		}
	} while ($process.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline)

	if ($process.MainWindowHandle -eq 0) {
		Write-Host 'Application stdout tail:'
		Get-Content -LiteralPath $stdoutPath -Tail 80 -ErrorAction SilentlyContinue
		Write-Host 'Application stderr tail:'
		Get-Content -LiteralPath $stderrPath -Tail 80 -ErrorAction SilentlyContinue
		throw 'Application did not create a main window within 30 seconds'
	}

	Start-Sleep -Seconds 5
	$process.Refresh()
	if ($process.HasExited) {
		Write-Host 'Application stdout tail:'
		Get-Content -LiteralPath $stdoutPath -Tail 80 -ErrorAction SilentlyContinue
		Write-Host 'Application stderr tail:'
		Get-Content -LiteralPath $stderrPath -Tail 80 -ErrorAction SilentlyContinue
		throw "Application exited after creating a window with exit code $($process.ExitCode)"
	}

	Write-Host "Verified packaged app starts and creates a main window: $($process.MainWindowTitle)"
} finally {
	if ($null -ne $process -and -not $process.HasExited) {
		$process.CloseMainWindow() | Out-Null
		if (-not $process.WaitForExit(5000)) {
			$process.Kill()
			$process.WaitForExit()
		}
	}

	$env:ETCHER_NO_SPAWN_UTIL = $previousNoSpawnUtil
	$env:ELECTRON_ENABLE_LOGGING = $previousElectronLogging
	$env:ELECTRON_NO_ATTACH_CONSOLE = $previousElectronConsole
}
