# Windows: the environment whisper.cpp (dictation) needs to build with
# clang-cl + Ninja, which `npm run tauri` sets by itself (scripts/tauri.mjs).
# For plain cargo, dot-source it first:  . .\scripts\cargo-env.ps1
# Values already set in the environment are kept.
$llvm = 'C:\Program Files\LLVM\bin'
$winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
$dirs = @($llvm, 'C:\Program Files\CMake\bin') +
  @(Get-ChildItem "$winget\Kitware.CMake*\*\bin", "$winget\Ninja-build.Ninja*" -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName)
foreach ($d in $dirs) { if ((Test-Path $d) -and ($env:PATH -notlike "*$d*")) { $env:PATH = "$d;$env:PATH" } }
if (Test-Path $llvm) {
  $defaults = @{ CMAKE_GENERATOR = 'Ninja'; CMAKE_C_COMPILER = 'clang-cl'; CMAKE_CXX_COMPILER = 'clang-cl'; CXXFLAGS = '-EHsc'; GGML_CCACHE = 'OFF'; LIBCLANG_PATH = $llvm }
  foreach ($k in $defaults.Keys) { if (-not [Environment]::GetEnvironmentVariable($k)) { Set-Item "env:$k" $defaults[$k] } }
}
