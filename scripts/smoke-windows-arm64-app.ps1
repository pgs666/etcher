$ErrorActionPreference = 'Stop'

function Test-PackagedApp {
	Param(
		[Parameter(Mandatory = $true)][string]$PackagePath,
		[Parameter(Mandatory = $true)][string]$Label
	)

	$appPath = Join-Path $PackagePath 'balenaEtcher.exe'
	if (-not (Test-Path -LiteralPath $appPath)) {
		throw "Missing $Label app executable: $appPath"
	}

	$stdoutPath = Join-Path $env:RUNNER_TEMP "balenaEtcher-$Label.stdout.log"
	$stderrPath = Join-Path $env:RUNNER_TEMP "balenaEtcher-$Label.stderr.log"
	$process = $null

	try {
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
				Write-Host "$Label application stdout tail:"
				Get-Content -LiteralPath $stdoutPath -Tail 80 -ErrorAction SilentlyContinue
				Write-Host "$Label application stderr tail:"
				Get-Content -LiteralPath $stderrPath -Tail 80 -ErrorAction SilentlyContinue
				throw "$Label application exited before creating a window with exit code $($process.ExitCode)"
			}
		} while ($process.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline)

		if ($process.MainWindowHandle -eq 0) {
			Write-Host "$Label application stdout tail:"
			Get-Content -LiteralPath $stdoutPath -Tail 80 -ErrorAction SilentlyContinue
			Write-Host "$Label application stderr tail:"
			Get-Content -LiteralPath $stderrPath -Tail 80 -ErrorAction SilentlyContinue
			throw "$Label application did not create a main window within 30 seconds"
		}

		Start-Sleep -Seconds 5
		$process.Refresh()
		if ($process.HasExited) {
			Write-Host "$Label application stdout tail:"
			Get-Content -LiteralPath $stdoutPath -Tail 80 -ErrorAction SilentlyContinue
			Write-Host "$Label application stderr tail:"
			Get-Content -LiteralPath $stderrPath -Tail 80 -ErrorAction SilentlyContinue
			throw "$Label application exited after creating a window with exit code $($process.ExitCode)"
		}

		Write-Host "Verified $Label app starts and creates a main window: $($process.MainWindowTitle)"
	} finally {
		if ($null -ne $process -and -not $process.HasExited) {
			$process.CloseMainWindow() | Out-Null
			if (-not $process.WaitForExit(5000)) {
				$process.Kill()
				$process.WaitForExit()
			}
		}
	}
}

$packageDir = Get-ChildItem -Path out -Directory -Filter 'balenaEtcher-win32-arm64' | Select-Object -First 1
if ($null -eq $packageDir) {
	throw 'Missing packaged app directory out/balenaEtcher-win32-arm64'
}

$zipFile = Get-ChildItem -Path out/make/zip/win32/arm64 -File -Filter '*.zip' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $zipFile) {
	throw 'Missing Windows ARM64 zip distributable'
}

$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$zipExtractDir = Join-Path $tempRoot 'etcher-arm64-app-smoke-zip'
Remove-Item -LiteralPath $zipExtractDir -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $zipFile.FullName -DestinationPath $zipExtractDir -Force

$previousNoSpawnUtil = $env:ETCHER_NO_SPAWN_UTIL
$previousElectronLogging = $env:ELECTRON_ENABLE_LOGGING
$previousElectronConsole = $env:ELECTRON_NO_ATTACH_CONSOLE

try {
	$env:ETCHER_NO_SPAWN_UTIL = '1'
	$env:ELECTRON_ENABLE_LOGGING = 'true'
	$env:ELECTRON_NO_ATTACH_CONSOLE = 'true'

	Test-PackagedApp -PackagePath $packageDir.FullName -Label 'packaged'
	Test-PackagedApp -PackagePath $zipExtractDir -Label 'zip distributable'
} finally {
	$env:ETCHER_NO_SPAWN_UTIL = $previousNoSpawnUtil
	$env:ELECTRON_ENABLE_LOGGING = $previousElectronLogging
	$env:ELECTRON_NO_ATTACH_CONSOLE = $previousElectronConsole
}
