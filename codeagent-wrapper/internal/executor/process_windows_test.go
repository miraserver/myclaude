//go:build windows

package executor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Self-exec exercises the real command runner, pipes, and Windows job object.
func TestWindowsProcessTreeHelper(t *testing.T) {
	mode := os.Getenv("EXECUTOR_WINDOWS_TREE_HELPER")
	if mode == "" {
		return
	}
	if mode == "sleep" {
		time.Sleep(60 * time.Second)
		os.Exit(0)
	}
	if mode != "cancel" && mode != "success" {
		fmt.Fprintln(os.Stderr, "unknown tree helper mode:", mode)
		os.Exit(2)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestWindowsProcessTreeHelper$")
	child.Env = append(os.Environ(), "EXECUTOR_WINDOWS_TREE_HELPER=sleep", "GORACE=atexit_sleep_ms=0")
	if mode == "success" {
		configureDetachedTestChild(child)
	}
	if err := child.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err := os.WriteFile(os.Getenv("EXECUTOR_WINDOWS_TREE_PID"), []byte(strconv.Itoa(child.Process.Pid)), 0600); err != nil {
		_ = child.Process.Kill()
		_ = child.Wait()
		fmt.Fprintln(os.Stderr, err)
		os.Exit(3)
	}
	if mode == "success" {
		fmt.Fprintln(os.Stdout, `{"type":"result","subtype":"success","session_id":"windows-tree-session","result":"final answer"}`)
		os.Exit(0)
	}
	time.Sleep(60 * time.Second)
	os.Exit(0)
}

func startWindowsProcessTreeHelper(t *testing.T, mode string) (int, <-chan TaskResult, context.CancelFunc) {
	t.Helper()
	pidFile := filepath.Join(t.TempDir(), "grandchild.pid")
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	t.Setenv("EXECUTOR_WINDOWS_TREE_HELPER", mode)
	t.Setenv("EXECUTOR_WINDOWS_TREE_PID", pidFile)
	original := commandContext
	commandContext = func(context.Context, string, ...string) *exec.Cmd {
		return exec.Command(os.Args[0], "-test.run=^TestWindowsProcessTreeHelper$")
	}
	t.Cleanup(func() { commandContext = original })
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	done := make(chan TaskResult, 1)
	finished := make(chan struct{})
	go func() {
		done <- runExecutorPipeHelper(ctx)
		close(finished)
	}()
	t.Cleanup(func() {
		cancel()
		// Read again on failure too, so a late PID publication is cleaned up.
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Error("Windows tree run did not stop during cleanup")
		}
		data, err := os.ReadFile(pidFile)
		if err != nil {
			return
		}
		pid, err := strconv.Atoi(string(data))
		if err != nil {
			t.Error(err)
			return
		}
		if !processStillRunning(pid) {
			return
		}
		proc, err := os.FindProcess(pid)
		if err != nil {
			t.Error(err)
			return
		}
		defer proc.Release()
		if err := proc.Kill(); err != nil && processStillRunning(pid) {
			t.Errorf("kill grandchild PID %d: %v", pid, err)
		}
		deadline := time.Now().Add(5 * time.Second)
		for processStillRunning(pid) && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		if processStillRunning(pid) {
			t.Errorf("grandchild PID %d survived cleanup", pid)
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(pidFile)
		if err == nil {
			// The file can be observed between creation and writing the PID.
			if pid, err := strconv.Atoi(string(data)); err == nil && pid > 0 {
				if !processStillRunning(pid) {
					t.Fatalf("grandchild PID %d exited before the assertion", pid)
				}
				return pid, done, cancel
			}
		} else if !os.IsNotExist(err) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("Windows helper did not publish its grandchild PID within 5s")
	return 0, done, cancel
}

func TestWindowsProcessTreeCancellationKillsGrandchild(t *testing.T) {
	pid, done, cancel := startWindowsProcessTreeHelper(t, "cancel")
	deadline := time.Now().Add(5 * time.Second)
	cancel()
	select {
	case result := <-done:
		if result.ExitCode != 130 {
			t.Fatalf("expected cancellation: %+v", result)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("Windows process tree cancellation did not return within 4s")
	}
	for processStillRunning(pid) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if processStillRunning(pid) {
		t.Fatalf("grandchild PID %d survived cancellation for 5s", pid)
	}
}

func TestWindowsProcessTreeSuccessPreservesDetachedGrandchild(t *testing.T) {
	pid, done, _ := startWindowsProcessTreeHelper(t, "success")
	select {
	case result := <-done:
		if result.ExitCode != 0 || result.Error != "" || result.Message != "final answer" || result.SessionID != "windows-tree-session" {
			t.Fatalf("expected successful final result: %+v", result)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("Windows successful run did not return within 4s")
	}
	if !processStillRunning(pid) {
		t.Fatalf("detached grandchild PID %d did not survive successful return", pid)
	}
}

func processStillRunning(pid int) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return err != windows.ERROR_INVALID_PARAMETER
	}
	defer windows.CloseHandle(handle)
	var code uint32
	return windows.GetExitCodeProcess(handle, &code) != nil || code == 259 // STILL_ACTIVE
}

func configureDetachedTestChild(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS}
}

func TestReapedProcessWithoutJobSkipsTermination(t *testing.T) {
	tree := processTree{proc: &os.Process{Pid: os.Getpid()}}
	tree.markReaped()
	if err := tree.kill(); err != nil {
		t.Fatal(err)
	}
}

func TestClosedReapedTreeKillSkipsTermination(t *testing.T) {
	cmd := exec.Command("cmd", "/C", "ping -n 2 127.0.0.1 >NUL")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	tree := processTree{}
	tree.attach(cmd.Process)
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	tree.close()
	tree.markReaped()
	if err := tree.kill(); err != nil {
		t.Fatal(err)
	}
	if tree.job != 0 {
		t.Fatalf("closed job handle was not cleared: %v", tree.job)
	}
}
