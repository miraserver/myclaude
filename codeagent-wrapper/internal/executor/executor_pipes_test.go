package executor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v3/process"
)

// Self-exec keeps these tests on the real exec.Cmd/OS-pipe execution path.
func TestExecutorPipeHelper(t *testing.T) {
	mode := os.Getenv("EXECUTOR_PIPE_HELPER")
	if mode == "" {
		return
	}
	if mode == "tail" {
		fmt.Fprintln(os.Stdout, `{"type":"noise","padding":"`+strings.Repeat("x", 2*1024*1024)+`"}`)
		fmt.Fprintln(os.Stdout, `{"type":"result","subtype":"success","session_id":"tail-session","result":"final answer"}`)
		os.Exit(0)
	}
	if mode == "hold" {
		// A release file and a deadline let the test clean up even on failure.
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(os.Getenv("EXECUTOR_PIPE_RELEASE")); err == nil {
				os.Exit(0)
			}
			time.Sleep(10 * time.Millisecond)
		}
		os.Exit(0)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestExecutorPipeHelper$")
	child.Env = append(os.Environ(), "EXECUTOR_PIPE_HELPER=hold")
	child.Stdout, child.Stderr = os.Stdout, os.Stderr
	if err := child.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err := os.WriteFile(os.Getenv("EXECUTOR_PIPE_READY"), []byte(strconv.Itoa(child.Process.Pid)), 0600); err != nil {
		os.Exit(3)
	}
	fmt.Fprintln(os.Stdout, `{"type":"result","subtype":"success","result":"final answer"}`)
	if mode == "exit-with-grandchild" {
		os.Exit(0)
	}
	// Cancellation kills this parent while its grandchild retains both pipes.
	time.Sleep(20 * time.Second)
	os.Exit(0)
}

func useExecutorPipeHelper(t *testing.T, mode string) {
	t.Helper()
	// Disable the race runtime's exit sleep in self-exec helpers so pipe timing stays accurate.
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	t.Setenv("EXECUTOR_PIPE_HELPER", mode)
	original := commandContext
	commandContext = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.CommandContext(ctx, os.Args[0], "-test.run=^TestExecutorPipeHelper$")
	}
	t.Cleanup(func() { commandContext = original })
}

func runExecutorPipeHelper(ctx context.Context) TaskResult {
	return RunCodexTaskWithContext(ctx, TaskSpec{ID: "pipes", Task: "hi", WorkDir: "."}, nil,
		"codex", func(*Config, string) []string { return nil }, nil, false, true, 0)
}

func TestExecutorRetainsOutputTail(t *testing.T) {
	useExecutorPipeHelper(t, "tail")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	for i := 0; i < 30; i++ {
		result := runExecutorPipeHelper(ctx)
		if result.ExitCode != 0 || result.Message != "final answer" || result.SessionID != "tail-session" {
			t.Fatalf("iteration %d: %+v", i, result)
		}
	}
}

func TestDrainWithGrace(t *testing.T) {
	t.Run("both done", func(t *testing.T) {
		parseDone := make(chan struct{})
		stderrDone := make(chan error, 1)
		close(parseDone)
		stderrDone <- nil
		start := time.Now()
		if !drainWithGrace(parseDone, stderrDone, time.Second) {
			t.Fatal("stderr was not reported drained")
		}
		if elapsed := time.Since(start); elapsed >= 100*time.Millisecond {
			t.Fatalf("drain took %v with both channels done", elapsed)
		}
	})
	t.Run("grace expires", func(t *testing.T) {
		grace := 100 * time.Millisecond
		start := time.Now()
		if drainWithGrace(make(chan struct{}), make(chan error), grace) {
			t.Fatal("stderr unexpectedly drained")
		}
		if elapsed := time.Since(start); elapsed < grace || elapsed > grace+250*time.Millisecond {
			t.Fatalf("drain took %v, want approximately %v", elapsed, grace)
		}
	})
}

func TestExecutorBoundsInheritedPipes(t *testing.T) {
	for _, mode := range []string{"cancel-with-grandchild", "exit-with-grandchild"} {
		t.Run(mode, func(t *testing.T) {
			useExecutorPipeHelper(t, mode)
			dir := t.TempDir()
			ready, release := filepath.Join(dir, "ready"), filepath.Join(dir, "release")
			t.Setenv("EXECUTOR_PIPE_READY", ready)
			t.Setenv("EXECUTOR_PIPE_RELEASE", release)
			t.Cleanup(func() {
				_ = os.WriteFile(release, nil, 0600)
				data, err := os.ReadFile(ready)
				if err != nil {
					return
				}
				pid, err := strconv.Atoi(string(data))
				if err != nil {
					t.Error(err)
					return
				}
				deadline := time.Now().Add(5 * time.Second)
				for time.Now().Before(deadline) {
					exists, _ := process.PidExists(int32(pid))
					statuses, _ := (&process.Process{Pid: int32(pid)}).Status()
					if !exists || (len(statuses) > 0 && statuses[0] == process.Zombie) {
						return
					}
					time.Sleep(10 * time.Millisecond)
				}
				t.Error("grandchild did not exit after release")
			})
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			done := make(chan TaskResult, 1)
			go func() { done <- runExecutorPipeHelper(ctx) }()
			deadline := time.Now().Add(5 * time.Second)
			for {
				if _, err := os.Stat(ready); err == nil {
					break
				}
				if time.Now().After(deadline) {
					cancel()
					<-done
					t.Fatal("helper did not start grandchild")
				}
				time.Sleep(10 * time.Millisecond)
			}
			start := time.Now()
			if mode == "cancel-with-grandchild" {
				cancel()
			}
			result := <-done
			elapsed := time.Since(start)
			if mode == "exit-with-grandchild" && elapsed > pipeDrainGracePeriod+500*time.Millisecond {
				t.Fatalf("grandchild-held stdout delayed return by %v: %+v", elapsed, result)
			}
			if elapsed > 4*time.Second {
				t.Fatalf("inherited pipes delayed return by %v: %+v", elapsed, result)
			}
			if mode == "cancel-with-grandchild" {
				if result.ExitCode != 130 {
					t.Fatalf("expected cancellation: %+v", result)
				}
			} else if result.ExitCode != 0 || result.Message != "final answer" {
				t.Fatalf("expected final output after child exit: %+v", result)
			}
		})
	}
}
