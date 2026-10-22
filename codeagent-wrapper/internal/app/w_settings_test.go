package wrapper

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	cli "codeagent-wrapper/internal/adapter/cli"
	rt "codeagent-wrapper/internal/application/runtask"
	rs "codeagent-wrapper/internal/application/runtaskset"
	config "codeagent-wrapper/internal/config"
	dt "codeagent-wrapper/internal/domain/task"

	"github.com/spf13/cobra"
)

func TestParallelInvalidWorkerEnvUsesResolverDefault(t *testing.T) {
	defer resetTestHooks()
	for _, raw := range []string{"abc", "8 ", "010"} {
		t.Run(raw, func(t *testing.T) {
			t.Setenv("CODEAGENT_MAX_PARALLEL_WORKERS", raw)
			v, err := config.NewViper("")
			if err != nil {
				t.Fatal(err)
			}
			opts := &cli.Options{}
			cmd := &cobra.Command{}
			cli.AddRootFlags(cmd.Flags(), opts)
			stdinReader = strings.NewReader("id: a\n---CONTENT---\nhello")
			called := false
			executeTaskLayersFn = func(_ context.Context, _ [][]rt.Spec, workers int, _ taskRunner) []dt.TaskResult {
				called = true
				if workers != config.DefaultMaxParallelWorkers || workers != config.ResolveMaxParallelWorkers() {
					t.Fatalf("workers=%d", workers)
				}
				return []dt.TaskResult{{TaskID: "a", Message: "done"}}
			}
			if code := runParallelMode(cmd, nil, opts, v, "wrapper"); code != 0 || !called {
				t.Fatalf("code=%d called=%v", code, called)
			}
		})
	}
}

func TestSettingsPrioritySingleAndParallel(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	dir := filepath.Join(home, ".codeagent")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "models.json"), []byte(`{"agents":{"preset":{"backend":"codex","model":"preset-model","reasoning":"high","prompt_file":"~/.codeagent/agents/preset.md"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	config.ResetModelsConfigCacheForTest()
	t.Cleanup(config.ResetModelsConfigCacheForTest)
	cfgPath := filepath.Join(home, "config.yaml")
	if err := os.WriteFile(cfgPath, []byte("reasoning-effort: low\nprompt-file: config.md\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, env := range []bool{false, true} {
		t.Setenv("CODEAGENT_REASONING_EFFORT", "")
		t.Setenv("CODEAGENT_PROMPT_FILE", "")
		fallbackReason, fallbackPrompt := "low", "config.md"
		if env {
			t.Setenv("CODEAGENT_REASONING_EFFORT", "medium")
			t.Setenv("CODEAGENT_PROMPT_FILE", "env.md")
			fallbackReason, fallbackPrompt = "medium", "env.md"
		}
		for _, tc := range []struct {
			args           []string
			reason, prompt string
			explicit       bool
		}{
			{[]string{"--agent", "preset", "hello"}, "high", "~/.codeagent/agents/preset.md", false},
			{[]string{"--agent", "preset", "--backend", "claude", "hello"}, fallbackReason, "~/.codeagent/agents/preset.md", false},
			{[]string{"--reasoning-effort", "minimal", "--prompt-file", "cli.md", "--agent", "preset", "hello"}, "minimal", "cli.md", true},
			{[]string{"hello"}, fallbackReason, fallbackPrompt, true},
		} {
			args := append([]string{"--config", cfgPath}, tc.args...)
			cfg, err := cli.ParseSingleConfig(args)
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Backend == "claude" && cfg.Model == "preset-model" {
				t.Fatal("preset model leaked across backend override")
			}
			if cfg.ReasoningEffort != tc.reason || cfg.PromptFile != tc.prompt || cfg.PromptFileExplicit != tc.explicit {
				t.Fatalf("%v: %+v", args, cfg)
			}
		}
		v, err := config.NewViper(cfgPath)
		if err != nil {
			t.Fatal(err)
		}
		input := rs.BuildInput{BackendName: "codex", ReasoningEffort: v.GetString("reasoning-effort"), PromptFile: v.GetString("prompt-file"), StdinData: []byte("id: a\nagent: preset\n---CONTENT---\nhi\n---TASK---\nid: b\n---CONTENT---\nhi\n---TASK---\nid: c\nagent: preset\nreasoning_effort: minimal\nprompt_file: explicit.md\n---CONTENT---\nhi\n---TASK---\nid: d\nagent: preset\nbackend: claude\n---CONTENT---\nhi")}
		plan, err := rs.BuildPlan(input, rs.BuildDeps{ResolveBackendName: func(s string) (string, error) { return s, nil }, ParseConfig: rs.ParseConfig, TopologicalSort: dt.TopologicalSort})
		if err != nil {
			t.Fatal(err)
		}
		flagInput := input
		flagInput.PromptFile = "cli.md"
		flagInput.PromptFileOverride = true
		flagPlan, err := rs.BuildPlan(flagInput, rs.BuildDeps{ResolveBackendName: func(s string) (string, error) { return s, nil }, ParseConfig: rs.ParseConfig, TopologicalSort: dt.TopologicalSort})
		if err != nil {
			t.Fatal(err)
		}
		for _, layer := range flagPlan.Layers {
			for _, task := range layer {
				if task.PromptFile != "cli.md" || !task.PromptFileExplicit {
					t.Fatalf("CLI priority: %+v", task)
				}
			}
		}
		for _, layer := range plan.Layers {
			for _, task := range layer {
				reason, prompt := fallbackReason, fallbackPrompt
				if task.ID == "a" {
					reason, prompt = "high", "~/.codeagent/agents/preset.md"
				}
				if task.ID == "c" {
					reason, prompt = "minimal", "~/.codeagent/agents/preset.md"
				}
				if task.ID == "d" {
					prompt = "~/.codeagent/agents/preset.md"
					if task.Model != "" || task.Yolo {
						t.Fatal("backend-specific preset settings leaked")
					}
				}
				if task.PromptFileExplicit != (task.ID == "b") {
					t.Fatalf("prompt source: %+v", task)
				}
				if task.ReasoningEffort != reason || task.PromptFile != prompt {
					t.Fatalf("parallel: %+v", task)
				}
			}
		}
	}
}

func TestDoubleDashTaskParsing(t *testing.T) {
	cfg, err := cli.ParseSingleConfig([]string{"--", "- task"})
	if err != nil || cfg.Task != "- task" {
		t.Fatalf("cfg=%+v err=%v", cfg, err)
	}
	if !shouldUseStdin(cfg.Task, false) {
		t.Fatal("task starting with dash would reach backend argv")
	}
	for _, char := range "&|<>^%!\"\n" {
		if !shouldUseStdin("task"+string(char), false) {
			t.Fatalf("metachar %q", char)
		}
	}
}
