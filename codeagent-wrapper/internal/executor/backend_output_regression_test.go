package executor

import (
	"context"
	"io"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

// Run the real task/parser pipeline with a zero-exit backend, without invoking
// installed tools or accessing user configuration.
func installOutputBackend(t *testing.T, output func(string) (string, string)) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	restore := SetNewCommandRunner(func(_ context.Context, _ string, args ...string) CommandRunner {
		stdout, stderr := output(args[0])
		return newRuntimeTestCmd(func(cmd *runtimeTestCmd) {
			go func() {
				_, _ = io.WriteString(cmd.stdoutW, stdout)
				_, _ = io.WriteString(cmd.stderrW, stderr)
				cmd.finish(nil)
			}()
		})
	})
	t.Cleanup(restore)
}

func runOutputTask(ts TaskSpec, _ int) TaskResult {
	return RunCodexTaskWithContext(ts.Context, ts, nil, "backend-test",
		func(*Config, string) []string { return []string{ts.ID} }, nil, false, true, 0)
}

func TestParallelTaskLogsCaptureBackendStreams(t *testing.T) {
	installOutputBackend(t, func(id string) (string, string) {
		return `{"type":"item.completed","item":{"type":"agent_message","text":"stdout-` + id + `"}}` + "\n", "stderr-" + id // Exercise flushing without a newline, too.
	})
	results := ExecuteConcurrentWithContext(context.Background(), [][]TaskSpec{{
		{ID: "log-a", Task: "hi", WorkDir: t.TempDir()},
		{ID: "log-b", Task: "hi", WorkDir: t.TempDir()},
	}}, 0, 2, runOutputTask)
	if len(results) != 2 {
		t.Fatalf("results=%v", results)
	}
	for _, result := range results {
		if result.ExitCode != 0 {
			t.Fatalf("result=%+v", result)
		}
		data, err := os.ReadFile(result.LogPath)
		if err != nil {
			t.Fatal(err)
		}
		for _, marker := range []string{"stdout-" + result.TaskID, "stderr-" + result.TaskID} {
			if !strings.Contains(string(data), marker) {
				t.Fatalf("task %s log missing %q: %s", result.TaskID, marker, data)
			}
		}
		other := "log-a"
		if result.TaskID == other {
			other = "log-b"
		}
		if strings.Contains(string(data), "stdout-"+other) || strings.Contains(string(data), "stderr-"+other) {
			t.Fatalf("task %s log contains another task's output", result.TaskID)
		}
	}
}

func TestTaskRejectsDamagedFinalOutput(t *testing.T) {
	const interim = `{"type":"item.completed","item":{"type":"agent_message","text":"interim"}}` + "\n"
	const final = `{"type":"item.completed","item":{"type":"agent_message","text":"final"}}` + "\n"
	const broken = `{"type":"item.completed","item":`
	oversized := `{"type":"item.completed","item":{"type":"agent_message","text":"` + strings.Repeat("x", 11*1024*1024) + `"}}`
	for _, tc := range []struct {
		name, tail string
		fail       bool
		want       string
	}{
		{"11MiB final", oversized, true, "interim"},
		{"truncated final", broken, true, "interim"},
		{"noise after final", final + "non-JSON noise\n", false, "final"},
		{"oversized noise after final", final + strings.Repeat("noise", 3*1024*1024), false, "final"},
		{"dropped then valid final", broken + "\n" + final, false, "final"},
		{"oversized then valid final", oversized + "\n" + final, false, "final"},
		{"dropped then completion", broken + "\n" + `{"type":"turn.completed"}` + "\n", false, "interim"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			installOutputBackend(t, func(string) (string, string) { return interim + tc.tail, "" })
			result := runOutputTask(TaskSpec{ID: "damaged-final", Task: "hi", WorkDir: t.TempDir(), Context: context.Background()}, 0)
			if (result.ExitCode != 0) != tc.fail || result.Message != tc.want {
				t.Fatalf("result=%+v", result)
			}
			if tc.fail {
				want := "backend output truncated/unparsable; final message may be lost; see log " + result.LogPath
				if result.LogPath == "" || result.Error != want {
					t.Fatalf("error=%q, want %q", result.Error, want)
				}
			} else if result.Error != "" {
				t.Fatalf("unexpected error: %s", result.Error)
			}
		})
	}
}

func TestOpenCodeErrorPreventsParallelDependent(t *testing.T) {
	var dependentRuns atomic.Int32
	installOutputBackend(t, func(id string) (string, string) {
		if id == "dependent" {
			dependentRuns.Add(1)
		}
		return `{"type":"text","sessionID":"sess-error","part":{"type":"text","text":"interim"}}` + "\n" +
			`{"type":"error","sessionID":"sess-error","error":{"name":"APIError","data":{"message":"distinct backend failure"}}}`, ""
	})
	results := ExecuteConcurrentWithContext(context.Background(), [][]TaskSpec{
		{{ID: "failed", Task: "hi", WorkDir: t.TempDir()}},
		{{ID: "dependent", Task: "hi", WorkDir: t.TempDir(), Dependencies: []string{"failed"}}},
	}, 0, 2, runOutputTask)
	if len(results) != 2 {
		t.Fatalf("results=%v", results)
	}
	for _, result := range results {
		if result.ExitCode == 0 {
			t.Fatalf("unexpected success: %+v", result)
		}
		if result.TaskID == "failed" && (!strings.Contains(result.Error, "distinct backend failure") || result.SessionID != "sess-error") {
			t.Fatalf("result=%+v", result)
		}
	}
	if dependentRuns.Load() != 0 {
		t.Fatal("dependent backend ran after OpenCode failure")
	}
}
