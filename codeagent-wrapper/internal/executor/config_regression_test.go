package executor

import (
	"context"
	"strings"
	"testing"

	"codeagent-wrapper/internal/worktree"
)

func TestInvalidResumeNeverCreatesWorktree(t *testing.T) {
	original := createWorktreeFn
	defer func() { createWorktreeFn = original }()
	createWorktreeFn = func(string) (*worktree.Paths, error) { t.Fatal("created worktree for invalid resume"); return nil, nil }
	res := RunCodexTaskWithContext(context.Background(), TaskSpec{Mode: "resume", Worktree: true}, nil, "", nil, nil, false, true, 0)
	if res.ExitCode != 1 {
		t.Fatal(res)
	}
}

func TestExecutorUsesWorktreeSubdirectory(t *testing.T) {
	original := createWorktreeFn
	defer func() { createWorktreeFn = original }()
	t.Setenv("DO_WORKTREE_DIR", "")
	createWorktreeFn = func(string) (*worktree.Paths, error) {
		return &worktree.Paths{Dir: "tree", WorkDir: "tree/sub", Branch: "do/test"}, nil
	}
	var got string
	res := RunCodexTaskWithContext(context.Background(), TaskSpec{Task: "hi", WorkDir: "repo/sub", Worktree: true}, nil, "nonexistent-codeagent-regression-command", func(cfg *Config, _ string) []string { got = cfg.WorkDir; return nil }, nil, false, true, 0)
	if res.WorktreePath != "tree" || res.WorktreeBranch != "do/test" {
		t.Fatal(res)
	}
	for _, summary := range []bool{true, false} {
		if !strings.Contains(GenerateFinalOutputWithMode([]TaskResult{res}, summary), "Worktree: tree (branch do/test)") {
			t.Fatal("missing worktree report")
		}
	}
	if got != "tree/sub" {
		t.Fatalf("workdir %q", got)
	}
}

func TestResumeHasExactlyOneWorkdirFlag(t *testing.T) {
	args := buildCodexArgs(&Config{Mode: "resume", SessionID: "sid", WorkDir: "repo"}, "task")
	count := 0
	for _, arg := range args {
		if arg == "-C" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("resume args contain %d -C flags: %v", count, args)
	}
}
