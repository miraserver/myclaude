package executor

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMissingWorkdirNeverLaunchesBackend(t *testing.T) {
	t.Setenv("DO_WORKTREE_DIR", "")
	dir := t.TempDir()
	file := filepath.Join(dir, "file")
	if err := os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	restore := SetNewCommandRunner(func(context.Context, string, ...string) CommandRunner {
		t.Error("backend constructed for invalid workdir")
		return newRuntimeTestCmd(func(cmd *runtimeTestCmd) { cmd.finish(nil) })
	})
	defer restore()
	for _, mode := range []string{"new", "resume"} {
		for _, backend := range []string{"codex", "claude", "gemini", "opencode"} {
			for _, path := range []string{filepath.Join(dir, "missing"), file} {
				t.Run(mode+"/"+backend+"/"+filepath.Base(path), func(t *testing.T) {
					b, err := selectBackendFn(backend)
					if err != nil {
						t.Fatal(err)
					}
					res := RunCodexTaskWithContext(context.Background(), TaskSpec{Mode: mode, SessionID: "sid", Task: "hi", WorkDir: path}, b, "", nil, nil, false, true, 0)
					if res.ExitCode != 1 || res.Error != "workdir not found: "+path {
						t.Fatalf("result=%+v", res)
					}
				})
			}
		}
	}
}

func TestParallelMissingWorkdirFailsAndSkipsDependents(t *testing.T) {
	t.Setenv("DO_WORKTREE_DIR", "")
	path := filepath.Join(t.TempDir(), "missing")
	restore := SetNewCommandRunner(func(context.Context, string, ...string) CommandRunner {
		t.Error("backend constructed for invalid workdir or skipped dependent")
		return newRuntimeTestCmd(func(cmd *runtimeTestCmd) { cmd.finish(nil) })
	})
	defer restore()
	results := ExecuteConcurrentWithContext(context.Background(), [][]TaskSpec{
		{{ID: "bad", Task: "hi", WorkDir: path}},
		{{ID: "dependent", Task: "hi", WorkDir: t.TempDir(), Dependencies: []string{"bad"}}},
	}, 0, 1, DefaultRunCodexTaskFn)
	if len(results) != 2 || results[0].ExitCode != 1 || results[0].Error != "workdir not found: "+path || !strings.Contains(results[1].Error, "skipped due to failed dependencies: bad") {
		t.Fatalf("results=%+v", results)
	}
}

func TestMissingPOSIXWorkdirWindowsHint(t *testing.T) {
	t.Setenv("DO_WORKTREE_DIR", "")
	if runtime.GOOS != "windows" {
		t.Skip("native launch path; portable hint cases covered by helper test")
	}
	path := "/missing-codeagent-workdir/" + filepath.Base(t.TempDir())
	res := RunCodexTaskWithContext(context.Background(), TaskSpec{Task: "hi", WorkDir: path}, nil, "nonexistent-codeagent-command", nil, nil, false, true, 0)
	want := "workdir not found: " + path + " (on Windows use a native path such as C:/..., e.g. from `cygpath -m`)"
	if res.ExitCode != 1 || res.Error != want {
		t.Fatalf("result=%+v", res)
	}
}

func TestWorkdirNotFoundHintByOS(t *testing.T) {
	for _, tc := range []struct {
		goos, path string
		hint       bool
	}{
		{"windows", "/tmp/x", true},
		{"windows", "C:/missing", false},
		{"linux", "/tmp/x", false},
		{"darwin", "/tmp/x", false},
	} {
		t.Run(tc.goos+"/"+tc.path, func(t *testing.T) {
			want := "workdir not found: " + tc.path
			if tc.hint {
				want += " (on Windows use a native path such as C:/..., e.g. from `cygpath -m`)"
			}
			if got := workdirNotFound(tc.path, tc.goos); got != want {
				t.Fatalf("got %q want %q", got, want)
			}
		})
	}
}
