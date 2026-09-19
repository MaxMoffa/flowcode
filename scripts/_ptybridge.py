# stdin bytes -> pty; pty output -> stdout. Test helper for codex-status-check.mjs.
import os, pty, sys, select, fcntl, termios, struct
COLS, ROWS = int(sys.argv[1]), int(sys.argv[2])
cwd = sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser("~")
shell = os.environ.get("SHELL", "/bin/bash")
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd); os.environ["TERM"] = "xterm-256color"; os.execv(shell, [shell])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
inp = sys.stdin.buffer.raw
out = sys.stdout.buffer
try:
    while True:
        r, _, _ = select.select([fd, inp], [], [], 0.2)
        if fd in r:
            try: d = os.read(fd, 65536)
            except OSError: break
            if not d: break
            out.write(d); out.flush()
        if inp in r:
            d = inp.read(4096)
            if not d: break
            os.write(fd, d)
finally:
    try: os.kill(pid, 9)
    except OSError: pass
