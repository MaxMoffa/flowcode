# CI, Windows: installs the Vulkan SDK whisper.cpp needs to build its GPU
# backend (dictation) and exports it to the following steps. The version is
# pinned with its hash; on a dev machine use `winget install KhronosGroup.VulkanSDK`.
$ErrorActionPreference = 'Stop'
$version = '1.4.363.0'
$sha256 = '94a82d378f7a5e3e54c9db7d2fb7016af136e14ac0a18dbf0f2f67a36352d141'
$root = 'C:\VulkanSDK'
$installer = Join-Path $env:RUNNER_TEMP 'vulkansdk.exe'

Invoke-WebRequest "https://sdk.lunarg.com/sdk/download/$version/windows/vulkansdk-windows-X64-$version.exe" -OutFile $installer
$actual = (Get-FileHash $installer -Algorithm SHA256).Hash
if ($actual -ne $sha256) { throw "Vulkan SDK installer hash mismatch: $actual" }

$process = Start-Process $installer -Wait -PassThru -ArgumentList '--root', $root, '--accept-licenses', '--default-answer', '--confirm-command', 'install'
if ($process.ExitCode -ne 0) { throw "Vulkan SDK installer failed: $($process.ExitCode)" }

"VULKAN_SDK=$root" >> $env:GITHUB_ENV
"$root\Bin" >> $env:GITHUB_PATH
