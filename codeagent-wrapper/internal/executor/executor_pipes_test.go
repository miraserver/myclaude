package executor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
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
	if mode == "hold-delayed-term" {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGTERM)
		_ = os.WriteFile(os.Getenv("EXECUTOR_PIPE_READY")+".child", nil, 0600)
		<-signals
		time.Sleep(100 * time.Millisecond)
		os.Exit(0)
	}
	if mode == "hold" || mode == "hold-ignore-term" {
		if mode == "hold-ignore-term" {
			signal.Ignore(syscall.SIGTERM)
			_ = os.WriteFile(os.Getenv("EXECUTOR_PIPE_READY")+".child", nil, 0600)
		}
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
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	child := exec.Command(os.Args[0], "-test.run=^TestExecutorPipeHelper$")
	childMode := "hold"
	if mode == "cancel-stubborn-grandchild" {
		childMode = "hold-ignore-term"
	}
	if mode == "cancel-delayed-grandchild" {
		childMode = "hold-delayed-term"
	}
	child.Env = append(os.Environ(), "EXECUTOR_PIPE_HELPER="+childMode)
	configureDetachedTestChild(child)
	child.Stdout, child.Stderr = os.Stdout, os.Stderr
	if err := child.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if mode == "cancel-stubborn-grandchild" || mode == "cancel-delayed-grandchild" {
		deadline := time.Now().Add(5 * time.Second)
		for {
			if _, err := os.Stat(os.Getenv("EXECUTOR_PIPE_READY") + ".child"); err == nil {
				break
			}
			if time.Now().After(deadline) {
				os.Exit(4)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	if err := os.WriteFile(os.Getenv("EXECUTOR_PIPE_READY"), []byte(strconv.Itoa(child.Process.Pid)), 0600); err != nil {
		os.Exit(3)
	}
	fmt.Fprintf(os.Stdout, "grandchild PID: %d\n", child.Process.Pid)
	fmt.Fprintln(os.Stdout, `{"type":"result","subtype":"success","result":"final answer"}`)
	if mode == "exit-with-grandchild" {
		os.Exit(0)
	}
	// Reap the grandchild on Unix so the assertion observes ESRCH, not a zombie.
	select {
	case <-signals:
		_ = child.Wait()
	case <-time.After(20 * time.Second):
	}
	os.Exit(0)
}

func useExecutorPipeHelper(t *testing.T, mode string) {
	t.Helper()
	// Disable the race runtime's exit sleep in self-exec helpers so pipe timing stays accurate.
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	t.Setenv("EXECUTOR_PIPE_HELPER", mode)
	original := commandContext
	commandContext = func(ctx context.Context, _ string, _ ...string) *exec.Cmd {
		return exec.Command(os.Args[0], "-test.run=^TestExecutorPipeHelper$")
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
	for _, mode := range []string{"cancel-with-grandchild", "cancel-stubborn-grandchild", "cancel-delayed-grandchild", "exit-with-grandchild"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "cancel-delayed-grandchild" && runtime.GOOS == "windows" {
				t.Skip("Unix graceful SIGTERM")
			}
			useExecutorPipeHelper(t, mode)
			delay := int32(1)
			if mode == "cancel-delayed-grandchild" {
				delay = 5
			}
			originalDelay := forceKillDelay.Swap(delay)
			t.Cleanup(func() { forceKillDelay.Store(originalDelay) })
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
			if mode != "exit-with-grandchild" {
				cancel()
			}
			result := <-done
			elapsed := time.Since(start)
			if mode == "cancel-delayed-grandchild" && elapsed >= 2*time.Second {
				t.Fatalf("delayed grandchild cancellation took %v", elapsed)
			}
			if mode == "exit-with-grandchild" && elapsed > pipeDrainGracePeriod+500*time.Millisecond {
				t.Fatalf("grandchild-held stdout delayed return by %v: %+v", elapsed, result)
			}
			if elapsed > 4*time.Second {
				t.Fatalf("inherited pipes delayed return by %v: %+v", elapsed, result)
			}
			if mode != "exit-with-grandchild" {
				data, err := os.ReadFile(ready)
				if err != nil {
					t.Fatal(err)
				}
				pid, err := strconv.Atoi(string(data))
				if err != nil {
					t.Fatal(err)
				}
				deadline := time.Now().Add(5 * time.Second)
				for processStillRunning(pid) && time.Now().Before(deadline) {
					time.Sleep(10 * time.Millisecond)
				}
				if processStillRunning(pid) {
					t.Fatalf("grandchild PID %d survived cancellation", pid)
				}
				if result.ExitCode != 130 {
					t.Fatalf("expected cancellation: %+v", result)
				}
			} else if data, err := os.ReadFile(ready); err != nil {
				t.Fatal(err)
			} else if pid, err := strconv.Atoi(string(data)); err != nil || !processStillRunning(pid) {
				t.Fatalf("grandchild did not survive successful return: pid=%d err=%v", pid, err)
			} else if result.ExitCode != 0 || result.Message != "final answer" {
				t.Fatalf("expected final output after child exit: %+v", result)
			}
		})
	}
}
