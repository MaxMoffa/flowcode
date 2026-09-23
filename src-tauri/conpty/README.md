# Sideloaded ConPTY

`conpty.dll` + `x64/OpenConsole.exe` from the
[`Microsoft.Windows.Console.ConPTY`](https://www.nuget.org/packages/Microsoft.Windows.Console.ConPTY)
NuGet package, version **1.24.260710001** (MIT, https://github.com/microsoft/terminal) -
the same ConPTY Windows Terminal ships, laid out as the package's own
`.targets` file does (`conpty.dll` beside the exe, the host in an `x64\` subfolder).

`portable-pty` loads a `conpty.dll` found next to `flowcode.exe` in preference
to the inbox one in kernel32. The inbox ConPTY swallows terminal queries such
as OSC 10/11 ("what's your background color?"), so TUIs that derive panel
shades from the terminal's background (Codex's input bar, for one) can't draw
them; this one passes them through to xterm.js.

Copied next to the exe by `src-tauri/build.rs` (dev/`cargo build`), staged by
`.github/workflows/release.yml`, and embedded/installed by the installer
(`installer/src/payload.rs`).

To update: download the package's `.nupkg` (a zip), take
`runtimes/win-x64/native/conpty.dll` and `build/native/runtimes/x64/OpenConsole.exe`,
and bump the version above.
