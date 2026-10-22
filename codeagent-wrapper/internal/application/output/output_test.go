package output

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	domaintask "codeagent-wrapper/internal/domain/task"
)

func TestSingleTaskReportsRetainedWorktreeEvenOnFailure(t *testing.T) {
	for _, message := range []string{"done", ""} {
		output, err := FinalizeSingleTask("codex", "", domaintask.TaskResult{ExitCode: 1, Message: message, WorktreePath: "repo/tree", WorktreeBranch: "do/task"})
		if err != nil || !strings.Contains(output.Stdout, "Worktree: repo/tree (branch do/task)") {
			t.Fatalf("output=%+v err=%v", output, err)
		}
	}
}

func TestRenderSingleTaskBanner(t *testing.T) {
	var stderr bytes.Buffer

	RenderSingleTaskBanner(&stderr, "codeagent-wrapper", "codex", []string{"codex", "exec", "-"}, 42, "/tmp/task.log")

	got := stderr.String()
	wantParts := []string{
		"[codeagent-wrapper]\n",
		"  Backend: codex\n",
		"  Command: codex exec -\n",
		"  PID: 42\n",
		"  Log: /tmp/task.log\n",
	}
	for _, want := range wantParts {
		if !strings.Contains(got, want) {
			t.Fatalf("banner missing %q in %q", want, got)
		}
	}
}

func TestFinalizeSingleTask_SuccessWithSession(t *testing.T) {
	outputPath := filepath.Join(t.TempDir(), "result.json")

	output, err := FinalizeSingleTask("codex", outputPath, domaintask.TaskResult{
		ExitCode:  0,
		Message:   "ok",
		SessionID: "tid-123",
	})
	if err != nil {
		t.Fatalf("FinalizeSingleTask() error = %v", err)
	}

	if output.ExitCode != 0 {
		t.Fatalf("ExitCode = %d, want 0", output.ExitCode)
	}
	if !strings.Contains(output.Stdout, "ok") || !strings.Contains(output.Stdout, "SESSION_ID: tid-123") {
		t.Fatalf("Stdout = %q, want message and session", output.Stdout)
	}

	data, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", outputPath, err)
	}
	if !strings.Contains(string(data), "\"message\":\"ok\"") || !strings.Contains(string(data), "\"session_id\":\"tid-123\"") {
		t.Fatalf("structured output = %q, want message and session", string(data))
	}
}

func TestFinalizeSingleTask_EmptySuccessBecomesError(t *testing.T) {
	outputPath := filepath.Join(t.TempDir(), "result.json")

	output, err := FinalizeSingleTask("codex", outputPath, domaintask.TaskResult{ExitCode: 0})
	if err != nil {
		t.Fatalf("FinalizeSingleTask() error = %v", err)
	}

	if output.ExitCode != 1 {
		t.Fatalf("ExitCode = %d, want 1", output.ExitCode)
	}
	if output.Stdout != "" {
		t.Fatalf("Stdout = %q, want empty", output.Stdout)
	}
	if !strings.Contains(output.LogError, "no output message: backend=codex") {
		t.Fatalf("LogError = %q, want synthesized no-output error", output.LogError)
	}

	data, err := os.ReadFile(outputPath)
	if err != nil {
		t.Fatalf("ReadFile(%q) error = %v", outputPath, err)
	}
	if !strings.Contains(string(data), "\"error\":\"no output message: backend=codex") {
		t.Fatalf("structured output = %q, want synthesized error", string(data))
	}
}

func TestEmit(t *testing.T) {
	var stdout bytes.Buffer

	Emit(&stdout, FinalizeParallel("summary", 7))

	if got := stdout.String(); got != "summary\n" {
		t.Fatalf("stdout = %q, want %q", got, "summary\n")
	}
}

func TestWorktreeOutputSanitized(t *testing.T) {
	result := domaintask.TaskResult{Message: "done", WorktreePath: "\x1b[31mrepo/tree\x1b[0m\x00", WorktreeBranch: "do/task\r"}
	output, err := FinalizeSingleTask("codex", "", result)
	if err != nil || !strings.Contains(output.Stdout, "Worktree: repo/tree (branch do/task)") || strings.ContainsAny(output.Stdout, "\x1b\x00\r") {
		t.Fatalf("%+v %v", output, err)
	}
}
