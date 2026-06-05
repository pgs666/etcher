$ErrorActionPreference = 'Stop'

$packageJson = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
$setupExe = Get-ChildItem -Path out/make/squirrel.windows/arm64 -File -Filter '*Setup.exe' -ErrorAction SilentlyContinue |
	Select-Object -First 1

if ($null -eq $setupExe) {
	throw 'Missing Windows ARM64 Squirrel Setup.exe'
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$setupStdoutPath = Join-Path $tempRoot 'balenaEtcher-installer.stdout.log'
$setupStderrPath = Join-Path $tempRoot 'balenaEtcher-installer.stderr.log'
$appStdoutPath = Join-Path $tempRoot 'balenaEtcher-installed.stdout.log'
$appStderrPath = Join-Path $tempRoot 'balenaEtcher-installed.stderr.log'
$installRoot = Join-Path $env:LOCALAPPDATA 'balena_etcher'
$installedAppDir = Join-Path $installRoot "app-$($packageJson.version)"
$installedAppPath = Join-Path $installedAppDir 'balenaEtcher.exe'
$updateExePath = Join-Path $installRoot 'Update.exe'
$appProcess = $null

function Stop-InstalledApp {
	Param([System.Diagnostics.Process]$Process)

	if ($null -ne $Process -and -not $Process.HasExited) {
		$Process.CloseMainWindow() | Out-Null
		if (-not $Process.WaitForExit(5000)) {
			$Process.Kill()
			$Process.WaitForExit()
		}
	}
}

try {
	Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue

	$setupProcess = Start-Process `
		-FilePath $setupExe.FullName `
		-ArgumentList '--silent' `
		-PassThru `
		-RedirectStandardOutput $setupStdoutPath `
		-RedirectStandardError $setupStderrPath

	if (-not $setupProcess.WaitForExit(120000)) {
		$setupProcess.Kill()
		$setupProcess.WaitForExit()
		Write-Host 'Installer stdout tail:'
		Get-Content -LiteralPath $setupStdoutPath -Tail 80 -ErrorAction SilentlyContinue
		Write-Host 'Installer stderr tail:'
		Get-Content -LiteralPath $setupStderrPath -Tail 80 -ErrorAction SilentlyContinue
		throw 'Installer did not exit within 120 seconds'
	}

	if ($setupProcess.ExitCode -ne 0) {
		Write-Host 'Installer stdout tail:'
		Get-Content -LiteralPath $setupStdoutPath -Tail 80 -ErrorAction SilentlyContinue
		Write-Host 'Installer stderr tail:'
		Get-Content -LiteralPath $setupStderrPath -Tail 80 -ErrorAction SilentlyContinue
		throw "Installer exited with code $($setupProcess.ExitCode)"
	}

	if (-not (Test-Path -LiteralPath $installedAppPath)) {
		Get-ChildItem -Path $installRoot -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
		throw "Installer did not create expected app executable: $installedAppPath"
	}

	$previousNoSpawnUtil = $env:ETCHER_NO_SPAWN_UTIL
	$previousElectronLogging = $env:ELECTRON_ENABLE_LOGGING
	$previousElectronConsole = $env:ELECTRON_NO_ATTACH_CONSOLE
	try {
		$env:ETCHER_NO_SPAWN_UTIL = '1'
		$env:ELECTRON_ENABLE_LOGGING = 'true'
		$env:ELECTRON_NO_ATTACH_CONSOLE = 'true'

		$appProcess = Start-Process `
			-FilePath $installedAppPath `
			-ArgumentList '--disable-gpu', '--disable-software-rasterizer' `
			-PassThru `
			-RedirectStandardOutput $appStdoutPath `
			-RedirectStandardError $appStderrPath

		$deadline = (Get-Date).AddSeconds(30)
		do {
			Start-Sleep -Milliseconds 500
			$appProcess.Refresh()
			if ($appProcess.HasExited) {
				Write-Host 'Installed app stdout tail:'
				Get-Content -LiteralPath $appStdoutPath -Tail 80 -ErrorAction SilentlyContinue
				Write-Host 'Installed app stderr tail:'
				Get-Content -LiteralPath $appStderrPath -Tail 80 -ErrorAction SilentlyContinue
				throw "Installed app exited before creating a window with exit code $($appProcess.ExitCode)"
			}
		} while ($appProcess.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline)

		if ($appProcess.MainWindowHandle -eq 0) {
			Write-Host 'Installed app stdout tail:'
			Get-Content -LiteralPath $appStdoutPath -Tail 80 -ErrorAction SilentlyContinue
			Write-Host 'Installed app stderr tail:'
			Get-Content -LiteralPath $appStderrPath -Tail 80 -ErrorAction SilentlyContinue
			throw 'Installed app did not create a main window within 30 seconds'
		}

		Write-Host "Verified Squirrel installer installs and installed app starts: $($appProcess.MainWindowTitle)"
	} finally {
		Stop-InstalledApp -Process $appProcess
		$env:ETCHER_NO_SPAWN_UTIL = $previousNoSpawnUtil
		$env:ELECTRON_ENABLE_LOGGING = $previousElectronLogging
		$env:ELECTRON_NO_ATTACH_CONSOLE = $previousElectronConsole
	}
} finally {
	Stop-InstalledApp -Process $appProcess
	if (Test-Path -LiteralPath $updateExePath) {
		$uninstallProcess = Start-Process `
			-FilePath $updateExePath `
			-ArgumentList '--uninstall', '-s' `
			-PassThru `
			-WindowStyle Hidden `
			-ErrorAction SilentlyContinue
		if ($null -ne $uninstallProcess -and -not $uninstallProcess.WaitForExit(60000)) {
			$uninstallProcess.Kill()
			$uninstallProcess.WaitForExit()
			Write-Host 'Squirrel uninstall did not exit within 60 seconds'
		}
		if ($null -ne $uninstallProcess -and $uninstallProcess.ExitCode -ne 0) {
			Write-Host "Squirrel uninstall exited with code $($uninstallProcess.ExitCode)"
		}
	}
	Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
}
