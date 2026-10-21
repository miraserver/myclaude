//go:build unix || darwin || linux

package wrapper

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestParallelSIGTERM(t *testing.T) {
	if os.Getenv("PARALLEL_SIGNAL_HELPER") == "1" {
		calls := 0
		runCodexTaskFn = func(task TaskSpec, _ int) TaskResult {
			calls++
			if err := os.WriteFile(os.Getenv("PARALLEL_SIGNAL_READY"), nil, 0600); err != nil {
				panic(err)
			}
			<-task.Context.Done()
			return TaskResult{TaskID: task.ID, ExitCode: 130, Error: "execution cancelled"}
		}
		stdinReader = bytes.NewBufferString("---TASK---\nid: 1\n---CONTENT---\none\n---TASK---\nid: 2\n---CONTENT---\ntwo\n---TASK---\nid: 3\n---CONTENT---\nthree\n")
		os.Args = []string{"codeagent-wrapper", "--parallel"}
		code := run()
		if code != 130 || calls != 1 {
			fmt.Fprintf(os.Stderr, "exit=%d calls=%d\n", code, calls)
			os.Exit(2)
		}
		os.Exit(0)
	}
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT} {
		t.Run(sig.String(), func(t *testing.T) {
			ready := filepath.Join(t.TempDir(), "ready")
			cmd := exec.Command(os.Args[0], "-test.run=^TestParallelSIGTERM$")
			cmd.Env = append(os.Environ(), "GORACE=atexit_sleep_ms=0", "PARALLEL_SIGNAL_HELPER=1", "PARALLEL_SIGNAL_READY="+ready, "CODEAGENT_MAX_PARALLEL_WORKERS=1")
			var output bytes.Buffer
			cmd.Stdout, cmd.Stderr = &output, &output
			if err := cmd.Start(); err != nil {
				t.Fatal(err)
			}
			defer cmd.Process.Kill()
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			deadline := time.Now().Add(5 * time.Second)
			for {
				if _, err := os.Stat(ready); err == nil {
					break
				}
				select {
				case err := <-done:
					t.Fatalf("helper exited: %v\n%s", err, &output)
				default:
				}
				if time.Now().After(deadline) {
					t.Fatal("helper did not start")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if err := cmd.Process.Signal(sig); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if err != nil {
					t.Fatalf("helper failed: %v\n%s", err, &output)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("parallel run ignored SIGTERM")
			}

		})
	}
}
