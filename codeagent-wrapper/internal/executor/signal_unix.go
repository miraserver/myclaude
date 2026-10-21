//go:build unix || darwin || linux

package executor

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

type processTree struct{ pid int }

func configureProcessTree(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

func (t *processTree) attach(proc *os.Process) { t.pid = proc.Pid }
func (t *processTree) close()                  {}
func (t *processTree) markReaped()             {}
func (t *processTree) signal(sig syscall.Signal) error {
	if t.pid <= 0 {
		return syscall.ESRCH
	}
	if err := syscall.Kill(-t.pid, 0); err != nil {
		return err
	}
	return syscall.Kill(-t.pid, sig)
}
func (t *processTree) kill() error { return t.signal(syscall.SIGKILL) }

func TerminationSignals() []os.Signal {
	return []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGQUIT}
}

// The leader may exit before descendants that ignore SIGTERM. Keep the grace
// timer alive, and finish escalation before the CLI can exit itself.
func finishTreeTermination(cmd commandRunner, timer *forceKillTimer) {
	if r, ok := cmd.(*realCmd); ok {
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for r.tree.pid > 0 && syscall.Kill(-r.tree.pid, 0) != syscall.ESRCH {
			select {
			case <-timer.done:
				timer.Stop()
				return
			case <-ticker.C:
			}
		}
	}
	timer.Stop()
}

func sendTermSignal(proc processHandle) error {
	if proc == nil {
		return nil
	}
	if p, ok := proc.(*realProcess); ok && p.tree != nil {
		return p.tree.signal(syscall.SIGTERM)
	}
	return proc.Signal(syscall.SIGTERM)
}
