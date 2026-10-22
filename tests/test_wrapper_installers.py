"""Full installer regressions with temporary homes and loopback downloads only."""

import contextlib
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shutil
import subprocess
import threading

import pytest


ROOT = Path(__file__).resolve().parents[1]


@contextlib.contextmanager
def release_server(binary):
    requests = []
    digest = hashlib.sha256(binary).hexdigest()
    manifest = "".join(
        f"{digest}  codeagent-wrapper-{system}-{arch}{suffix}\n"
        for system, suffix in (("windows", ".exe"), ("linux", ""), ("darwin", ""))
        for arch in ("amd64", "arm64")
    ).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()
            self.wfile.write(manifest if self.path.endswith("/SHA256SUMS") else binary)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", requests
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@pytest.fixture(scope="module")
def windows_binaries(tmp_path_factory):
    if os.name != "nt":
        pytest.skip("requires Windows cmd.exe and PowerShell")
    root = tmp_path_factory.mktemp("installer-executables")
    for name, code in (("working", 0), ("broken", 23)):
        source = root / f"{name}.cs"
        source.write_text(
            f"public class Program {{ public static int Main(string[] args) {{ return {code}; }} }}",
            encoding="utf-8",
        )
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command",
             "Add-Type -Path $env:TEST_SOURCE -OutputAssembly $env:TEST_BINARY "
             "-OutputType ConsoleApplication"],
            env={**os.environ, "TEST_SOURCE": str(source),
                 "TEST_BINARY": str(root / f"{name}.exe")},
            capture_output=True, text=True, timeout=60,
        )
        assert result.returncode == 0, result.stdout + result.stderr
    return {name: (root / f"{name}.exe").read_bytes() for name in ("working", "broken")}


@pytest.mark.parametrize("success", [False, True], ids=["rollback", "success"])
@pytest.mark.parametrize("existing", [True, False], ids=["upgrade", "fresh"])
def test_install_bat_through_cmd_exe(tmp_path, windows_binaries, success, existing):
    dest = tmp_path / "bin" / "codeagent-wrapper.exe"
    dest.parent.mkdir()
    old = windows_binaries["working"] + b"old wrapper bytes"
    if existing:
        dest.write_bytes(old)
        assert subprocess.run([str(dest), "--version"], timeout=10).returncode == 0
    incoming = windows_binaries["working" if success else "broken"]

    # Stub registry queries so the successful install never writes the real registry.
    tools = tmp_path / "tools"
    tools.mkdir()
    (tools / "reg.cmd").write_text(
        '@echo off\nif /I "%1"=="query" (\n'
        '  echo     Path    REG_EXPAND_SZ    %USERPROFILE%\\bin\n'
        '  exit /b 0\n)\nexit /b 99\n', encoding="utf-8",
    )
    with release_server(incoming) as (origin, requests):
        # Run the entire real installer; change only the download origin in this
        # temporary copy, as the production URL intentionally has no test override.
        script = (ROOT / "install.bat").read_text(encoding="utf-8")
        script = script.replace("https://github.com/%REPO%", origin)
        harness = tmp_path / "install.bat"
        harness.write_text(script, encoding="utf-8")
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", str(harness)], cwd=tools,
            env={**os.environ, "USERPROFILE": str(tmp_path), "HOME": str(tmp_path),
                 "TEMP": str(tmp_path), "TMP": str(tmp_path),
                 "PROCESSOR_ARCHITECTURE": "AMD64", "PROCESSOR_ARCHITEW6432": "AMD64",
                 "CODEAGENT_WRAPPER_VERSION": "v-test", "NO_PROXY": "127.0.0.1",
                 "PATH": str(tools) + os.pathsep + os.environ["PATH"]},
            capture_output=True, text=True, timeout=60,
        )
    output = result.stdout + result.stderr
    assert result.returncode == (0 if success else 1), output
    assert requests == [
        "/releases/download/v-test/codeagent-wrapper-windows-amd64.exe",
        "/releases/download/v-test/SHA256SUMS",
    ], output
    if success:
        assert "installed successfully" in output
        assert dest.read_bytes() == incoming
    else:
        assert "installation verification failed" in output
        if existing:
            assert dest.read_bytes() == old
            assert subprocess.run([str(dest), "--version"], timeout=10).returncode == 0
        else:
            assert not dest.exists()
    assert not Path(str(dest) + ".old").exists()
    assert not list(tmp_path.glob("codeagent-wrapper-*.exe"))


def bash_path(path):
    value = path.as_posix()
    if os.name == "nt":
        return "/" + value[0].lower() + value[2:]
    return value


@pytest.mark.parametrize("success", [False, True], ids=["rollback", "success"])
@pytest.mark.parametrize("existing", [True, False], ids=["upgrade", "fresh"])
def test_install_sh(tmp_path, request, success, existing):
    bash = shutil.which("bash")
    if not bash:
        pytest.skip("requires bash")
    # Git Bash detects Windows and installs the .exe asset; native Bash uses a script.
    suffix = ".exe" if os.name == "nt" else ""
    dest = tmp_path / "install" / "bin" / ("codeagent-wrapper" + suffix)
    dest.parent.mkdir(parents=True)
    old = b"#!/bin/sh\n# old working wrapper\nexit 0\n"
    incoming = f"#!/bin/sh\nexit {0 if success else 23}\n".encode()
    if os.name == "nt":
        binaries = request.getfixturevalue("windows_binaries")
        old = binaries["working"] + b"old wrapper bytes"
        incoming = binaries["working" if success else "broken"]
    if existing:
        dest.write_bytes(old)
        dest.chmod(0o755)
    with release_server(incoming) as (origin, requests):
        script = (ROOT / "install.sh").read_text(encoding="utf-8")
        script = script.replace("https://github.com/${REPO}", origin)
        harness = tmp_path / "install.sh"
        harness.write_text(script, encoding="utf-8")
        result = subprocess.run(
            [bash, bash_path(harness)], cwd=tmp_path,
            env={**os.environ, "HOME": bash_path(tmp_path), "TMPDIR": bash_path(tmp_path),
                 "INSTALL_DIR": bash_path(dest.parent.parent), "SKIP_WARNING": "1",
                 "CODEAGENT_WRAPPER_VERSION": "v-test", "NO_PROXY": "127.0.0.1",
                 "PATH": str(dest.parent) + os.pathsep + os.environ["PATH"]},
            capture_output=True, text=True, timeout=30,
        )
    output = result.stdout + result.stderr
    assert result.returncode == (0 if success else 1), output
    assert len(requests) == 2 and requests[-1].endswith("/SHA256SUMS"), output
    if success:
        assert dest.read_bytes() == incoming
    else:
        assert "installation verification failed" in output
        if existing:
            assert dest.read_bytes() == old
            assert subprocess.run([str(dest), "--version"], timeout=10).returncode == 0
        else:
            assert not dest.exists()
    assert not Path(str(dest) + ".old").exists()


def test_install_bat_powershell_has_no_exclamation_marks():
    commands = [line for line in (ROOT / "install.bat").read_text().splitlines()
                if "powershell " in line.lower() and "-command " in line.lower()]
    assert commands
    assert all("!" not in line for line in commands)
