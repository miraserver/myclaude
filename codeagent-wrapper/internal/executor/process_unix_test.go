//go:build unix || darwin || linux

package executor

import (
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func processStillRunning(pid int) bool {
	return syscall.Kill(pid, 0) != syscall.ESRCH
}

func configureDetachedTestChild(cmd *exec.Cmd) {}

func TestTreePollHelper(t *testing.T) {
	if os.Getenv("TREE_POLL_HELPER") != "1" {
		return
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM)
	if err := os.WriteFile(os.Getenv("TREE_POLL_READY"), nil, 0600); err != nil {
		os.Exit(2)
	}
	<-signals
	time.Sleep(100 * time.Millisecond)
	os.Exit(0)
}

func TestFinishTreeTerminationPollsUntilGroupExits(t *testing.T) {
	ready := filepath.Join(t.TempDir(), "ready")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestTreePollHelper$")
	cmd.Env = append(os.Environ(), "TREE_POLL_HELPER=1", "TREE_POLL_READY="+ready, "GORACE=atexit_sleep_ms=0")
	runner := &realCmd{cmd: cmd}
	if err := runner.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Process.Kill()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("helper not ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	done := make(chan error, 1)
	go func() { done <- runner.Wait() }()
	original := forceKillDelay.Swap(5)
	defer forceKillDelay.Store(original)
	start := time.Now()
	timer := terminateCommand(runner)
	finishTreeTermination(runner, timer)
	if elapsed := time.Since(start); elapsed >= 2*time.Second {
		t.Fatalf("waited %v for short-lived group", elapsed)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
