package wrapper

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	cli "codeagent-wrapper/internal/adapter/cli"
	rt "codeagent-wrapper/internal/application/runtask"
	rs "codeagent-wrapper/internal/application/runtaskset"
	"codeagent-wrapper/internal/config"
	dt "codeagent-wrapper/internal/domain/task"
	"codeagent-wrapper/internal/executor"

	"github.com/spf13/viper"
)

func TestConfigCLIRegressions(t *testing.T) {
	defer resetTestHooks()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	config.ResetModelsConfigCacheForTest()
	t.Cleanup(config.ResetModelsConfigCacheForTest)
	dir := filepath.Join(home, ".codeagent")
	if err := os.MkdirAll(filepath.Join(dir, "agents"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "models.json"), []byte(`{"default_backend":"codex","default_model":"codex-model","agents":{"develop":{"backend":"codex","model":"codex-model","yolo":true}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_BYPASS_SANDBOX", "false")
	t.Setenv("CODEAGENT_SKIP_PERMISSIONS", "false")
	for _, enabled := range []bool{false, true} {
		t.Setenv("CODEAGENT_SKIP_PERMISSIONS", fmt.Sprint(enabled))
		for _, backend := range []string{"codex", "claude"} {
			for _, parallel := range []bool{false, true} {
				var spec rt.Spec
				if parallel {
					cfg, err := rs.ParseConfig([]byte("id: a\nagent: develop\nbackend: " + backend + "\nsession_id: sid\nworkdir: " + home + "\n---CONTENT---\nhello"))
					if err != nil {
						t.Fatal(err)
					}
					spec = cfg.Tasks[0]
				} else {
					cfg, err := cli.ParseSingleConfig([]string{"--agent", "develop", "--backend", backend, "resume", "sid", "hello", home})
					if err != nil {
						t.Fatal(err)
					}
					plan, err := rt.PrepareConfigPlan(cfg, rt.PrepareDeps{ResolveTaskText: func(c rt.Command) (string, bool, error) { return c.Task, false, nil }, ApplyPromptAndSkills: func(_ rt.Command, s string) (string, error) { return s, nil }, ShouldUseStdin: func(string, bool) bool { return false }, BuildCommandArgs: buildSingleTaskCommandArgs})
					if err != nil {
						t.Fatal(err)
					}
					spec = plan.TaskSpec
				}
				if spec.Yolo != (backend == "codex") {
					t.Fatal("lost preset yolo")
				}
				if backend == "claude" && spec.Model != "" {
					t.Fatalf("cross-backend model: %q", spec.Model)
				}
				var args []string
				fake := newFakeCmd(fakeCmdConfig{StdoutPlan: []fakeStdoutEvent{{Data: "{\"type\":\"result\",\"result\":\"done\"}\n"}}})
				restore := executor.SetNewCommandRunner(func(_ context.Context, _ string, a ...string) executor.CommandRunner { args = a; return fake })
				b, err := selectBackend(backend)
				if err != nil {
					t.Fatal(err)
				}
				_ = executor.RunCodexTaskWithContext(context.Background(), spec, b, "", nil, nil, false, true, 0)
				restore()
				flag := "--dangerously-bypass-approvals-and-sandbox"
				if backend == "claude" {
					flag = "--dangerously-skip-permissions"
				}
				if strings.Contains(strings.Join(args, " "), flag) != (backend == "codex" || enabled) {
					t.Fatalf("missing yolo flag: %v", args)
				}
			}
		}
	}
	cfg, err := cli.ParseSingleConfig([]string{"--agent", "develop", "--backend", "claude", "--model", "explicit", "hello"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Model != "explicit" {
		t.Fatal(cfg.Model)
	}
	prompt := filepath.Join(dir, "agents", "x.md")
	if err := os.WriteFile(prompt, []byte("prompt"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readAgentPromptFile("~/.codeagent/agents/x.md", false); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"~/.codeagent/models.json", "~/.codeagent/prompts/x.md", "~/.codeagent/../evil.md", "~/.ssh/id"} {
		if _, err := readAgentPromptFile(path, false); err == nil {
			t.Fatalf("accepted %s", path)
		}
	}
	for raw, want := range map[string]int{"abc": 10, "8 ": 10, "010": 10} {
		t.Setenv("CODEAGENT_MAX_PARALLEL_WORKERS", raw)
		v := viper.New()
		v.Set("max-parallel-workers", raw)
		if got := resolveConfiguredMaxParallelWorkers(v); got != want {
			t.Fatalf("workers %q: %d", raw, got)
		}
	}
}

func TestGlobalModelOnlyMatchesBackend(t *testing.T) {
	plan, err := rs.BuildPlan(rs.BuildInput{BackendName: "codex", Model: "codex-model", StdinData: []byte("id: a\nbackend: claude\n---CONTENT---\nhello\n---TASK---\nid: b\n---CONTENT---\nhello")}, rs.BuildDeps{ResolveBackendName: func(s string) (string, error) { return s, nil }, ParseConfig: rs.ParseConfig, TopologicalSort: dt.TopologicalSort})
	if err != nil {
		t.Fatal(err)
	}
	for _, layer := range plan.Layers {
		for _, task := range layer {
			if task.Backend == "claude" && task.Model != "" {
				t.Fatal(task)
			}
			if task.Backend == "codex" && task.Model != "codex-model" {
				t.Fatal(task)
			}
		}
	}
}

func TestResumeCommandDirectory(t *testing.T) {
	defer resetTestHooks()
	for _, backend := range []string{"claude", "gemini", "opencode"} {
		for _, dir := range []string{"", t.TempDir()} {
			runner := &directoryRunner{fakeCmd: newFakeCmd(fakeCmdConfig{})}
			restore := executor.SetNewCommandRunner(func(context.Context, string, ...string) executor.CommandRunner { return runner })
			b, err := selectBackend(backend)
			if err != nil {
				t.Fatal(err)
			}
			_ = executor.RunCodexTaskWithContext(context.Background(), rt.Spec{Mode: "resume", SessionID: "sid", Task: "hi", WorkDir: dir}, b, "", nil, nil, false, true, 0)
			restore()
			if runner.dir != dir {
				t.Fatalf("%s Dir=%q want %q", backend, runner.dir, dir)
			}
		}
	}
}

type directoryRunner struct {
	*fakeCmd
	dir string
}

func (r *directoryRunner) SetDir(s string) { r.dir = s }
