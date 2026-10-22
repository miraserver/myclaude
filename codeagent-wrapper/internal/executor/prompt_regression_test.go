package executor

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	rs "codeagent-wrapper/internal/application/runtaskset"
	config "codeagent-wrapper/internal/config"
	dt "codeagent-wrapper/internal/domain/task"
)

func TestPromptBackendHelper(t *testing.T) {
	if os.Getenv("CODEAGENT_TEST_PROMPT_HELPER") != "1" {
		return
	}
	data, err := io.ReadAll(os.Stdin)
	if err != nil || !strings.Contains(string(data), "persona from temp file") || !strings.Contains(string(data), "task body") {
		os.Exit(2)
	}
	fmt.Println(`{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}`)
	os.Exit(0)
}

func TestParallelUserPromptOutsideRoots(t *testing.T) {
	prompt := filepath.Join(t.TempDir(), "persona.md")
	if err := os.WriteFile(prompt, []byte("persona from temp file"), 0600); err != nil {
		t.Fatal(err)
	}
	original := newCommandRunner
	defer func() { newCommandRunner = original }()
	t.Setenv("CODEAGENT_TEST_PROMPT_HELPER", "1")
	t.Setenv("DO_WORKTREE_DIR", "")
	newCommandRunner = func(ctx context.Context, _ string, args ...string) commandRunner {
		if len(args) == 0 || args[len(args)-1] != "-" {
			t.Errorf("expected stdin target, args=%v", args)
		}
		return &realCmd{cmd: exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPromptBackendHelper$")}
	}
	for _, source := range []string{"env", "config", "CLI"} {
		t.Run(source, func(t *testing.T) {
			t.Setenv("CODEAGENT_PROMPT_FILE", "")
			v, err := config.NewViper("")
			if err != nil {
				t.Fatal(err)
			}
			if source == "env" {
				t.Setenv("CODEAGENT_PROMPT_FILE", prompt)
			} else {
				v.Set("prompt-file", prompt)
			}
			plan, err := rs.BuildPlan(rs.BuildInput{BackendName: "codex", PromptFile: v.GetString("prompt-file"), PromptFileOverride: source == "CLI", StdinData: []byte("id: a\n---CONTENT---\ntask body")}, rs.BuildDeps{ResolveBackendName: func(s string) (string, error) { return s, nil }, ParseConfig: rs.ParseConfig, TopologicalSort: dt.TopologicalSort})
			if err != nil {
				t.Fatal(err)
			}
			result := DefaultRunCodexTaskFn(plan.Layers[0][0], 0)
			if result.ExitCode != 0 || result.Message != "ok" {
				t.Fatalf("%+v", result)
			}
		})
	}
}

func TestParallelPresetPromptOutsideRootsRejected(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	dir := filepath.Join(home, ".codeagent")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	prompt := filepath.Join(t.TempDir(), "persona.md")
	if err := os.WriteFile(prompt, []byte("persona"), 0600); err != nil {
		t.Fatal(err)
	}
	data := fmt.Sprintf(`{"agents":{"develop":{"backend":"codex","model":"preset-model","prompt_file":%q}}}`, filepath.ToSlash(prompt))
	if err := os.WriteFile(filepath.Join(dir, "models.json"), []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	config.ResetModelsConfigCacheForTest()
	t.Cleanup(config.ResetModelsConfigCacheForTest)
	cfg, err := rs.ParseConfig([]byte("id: a\nagent: develop\nbackend: claude\n---CONTENT---\ntask body"))
	if err != nil {
		t.Fatal(err)
	}
	result := DefaultRunCodexTaskFn(cfg.Tasks[0], 0)
	if result.ExitCode != 1 || !strings.Contains(result.Error, "prompt file must be under") {
		t.Fatalf("%+v", result)
	}
}

func TestParallelLeadingDashUsesStdin(t *testing.T) {
	original := newCommandRunner
	defer func() { newCommandRunner = original }()
	called := false
	newCommandRunner = func(ctx context.Context, _ string, args ...string) commandRunner {
		called = true
		if args[len(args)-1] != "-" {
			t.Errorf("leading dash passed as argv: %v", args)
		}
		return &realCmd{cmd: exec.CommandContext(ctx, "nonexistent-codeagent-regression-command")}
	}
	DefaultRunCodexTaskFn(TaskSpec{Task: "- task", WorkDir: t.TempDir(), Backend: "codex"}, 0)
	if !called {
		t.Fatal("backend not invoked")
	}
}
