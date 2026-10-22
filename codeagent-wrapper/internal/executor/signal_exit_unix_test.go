//go:build !windows

package executor

import (
	"context"
	"os"
	"os/exec"
	"testing"
)

func TestSignalExitHelper(t *testing.T) {
	if os.Getenv("CODEAGENT_SIGNAL_EXIT_HELPER") != "1" {
		return
	}
	p, _ := os.FindProcess(os.Getpid())
	_ = p.Kill()
	os.Exit(42)
}

func TestUncancelledSignalExitMapsToOne(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestSignalExitHelper$")
	cmd.Env = append(os.Environ(), "CODEAGENT_SIGNAL_EXIT_HELPER=1")
	err, ok := cmd.Run().(*exec.ExitError)
	if !ok || err.ExitCode() != -1 {
		t.Fatalf("helper exit = %v", err)
	}
	restore := SetNewCommandRunner(func(context.Context, string, ...string) CommandRunner {
		return newRuntimeTestCmd(func(c *runtimeTestCmd) { c.finish(err) })
	})
	defer restore()
	res := RunCodexTaskWithContext(context.Background(), TaskSpec{Task: "hi"}, nil, "missing-signal-test-backend", nil, nil, false, true, 0)
	if res.ExitCode != 1 {
		t.Fatalf("signal exit = %+v", res)
	}
}
