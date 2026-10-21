//go:build windows

package executor

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

type processTree struct {
	mu     sync.Mutex
	reaped bool
	job    windows.Handle
	proc   *os.Process
}

func configureProcessTree(cmd *exec.Cmd) {}

// Assign immediately after Start, before any cancellation can kill the leader.
// Descendants inherit membership, including those behind .cmd launchers.
func (t *processTree) attach(proc *os.Process) {
	t.proc = proc
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		logWarn("CreateJobObject: " + err.Error())
		return
	}
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(proc.Pid))
	if err == nil {
		err = windows.AssignProcessToJobObject(job, handle)
		windows.CloseHandle(handle)
	}

	if err != nil {
		windows.CloseHandle(job)
		logWarn("Assign process to job: " + err.Error())
		return
	}
	t.job = job
}

func TerminationSignals() []os.Signal { return []os.Signal{os.Interrupt, syscall.SIGTERM} }

func (t *processTree) markReaped() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.reaped = true
}

func (t *processTree) close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job != 0 {
		windows.CloseHandle(t.job)
		t.job = 0
	}
}

func (t *processTree) kill() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.job != 0 {
		return windows.TerminateJobObject(t.job, 1)
	}
	if t.reaped {
		return nil
	}
	return killWithTaskkill(t.proc)
}

func finishTreeTermination(_ commandRunner, timer *forceKillTimer) { timer.Stop() }

func sendTermSignal(proc processHandle) error {
	if proc == nil {
		return nil
	}
	if p, ok := proc.(*realProcess); ok && p.tree != nil {
		return p.tree.kill()
	}
	return proc.Kill()
}

// Only used when job setup failed. Run on the live leader before killing it.
func killWithTaskkill(proc *os.Process) error {
	if proc == nil {
		return nil
	}
	taskkill := "taskkill"
	if root := os.Getenv("SystemRoot"); root != "" {
		taskkill = filepath.Join(root, "System32", "taskkill.exe")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(proc.Pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return err
	}
	if code != 259 {
		return os.ErrProcessDone
	} // STILL_ACTIVE
	ctx, cancel := context.WithTimeout(context.Background(), forceKillWaitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, taskkill, "/PID", strconv.Itoa(proc.Pid), "/T", "/F")
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err == nil {
		return nil
	}
	return proc.Kill()
}
