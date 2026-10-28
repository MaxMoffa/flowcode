# Windows: the environment whisper.cpp (dictation) needs to build with
# clang-cl + Ninja, which `npm run tauri` sets by itself (scripts/tauri.mjs).
# For plain cargo, dot-source it first:  . .\scripts\cargo-env.ps1
$llvm = 'C:\Program Files\LLVM\bin'
$winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
$dirs = @($llvm, 'C:\Program Files\CMake\bin') +
  @(Get-ChildItem "$winget\Kitware.CMake*\*\bin", "$winget\Ninja-build.Ninja*" -Directory -ErrorAction SilentlyContinue | ForEach-Object FullName)
foreach ($d in $dirs) { if ((Test-Path $d) -and ($env:PATH -notlike "*$d*")) { $env:PATH = "$d;$env:PATH" } }
$env:CMAKE_GENERATOR = 'Ninja'
$env:CMAKE_C_COMPILER = 'clang-cl'
$env:CMAKE_CXX_COMPILER = 'clang-cl'
$env:CXXFLAGS = '-EHsc'
$env:GGML_CCACHE = 'OFF'
$env:LIBCLANG_PATH = $llvm
