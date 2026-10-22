package wrapper

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	cli "codeagent-wrapper/internal/adapter/cli"
	rt "codeagent-wrapper/internal/application/runtask"
	rs "codeagent-wrapper/internal/application/runtaskset"
	"codeagent-wrapper/internal/config"
	dt "codeagent-wrapper/internal/domain/task"
	"codeagent-wrapper/internal/executor"
	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

func TestSingleTaskInputPrecedence(t *testing.T) {
	defer resetTestHooks()
	isTerminalFn = func() bool { return false }
	r, w := io.Pipe() // The writer deliberately stays open: no EOF is possible.
	defer r.Close()
	defer w.Close()
	stdinReader = r
	type outcome struct {
		task  string
		piped bool
		err   error
	}
	done := make(chan outcome, 1)
	go func() {
		task, piped, err := resolveSingleTaskText(rt.Command{Task: "argv task"})
		done <- outcome{task, piped, err}
	}()
	select {
	case got := <-done:
		if got.err != nil || got.task != "argv task" || got.piped {
			t.Fatalf("positional task: %+v", got)
		}
	case <-time.After(time.Second):
		// Unblock the reader before restoring global hooks, including on regression.
		_ = w.Close()
		<-done
		t.Fatal("positional task blocked on stdin")
	}
	cfg, err := cli.ParseSingleConfig([]string{""})
	if err != nil {
		t.Fatal(err)
	}
	stdinReader = errReader{err: io.ErrUnexpectedEOF}
	if _, _, err := resolveSingleTaskText(rt.Command{Task: cfg.Task, TaskProvided: cfg.TaskProvided}); err == nil || err.Error() != "task required" {
		t.Fatalf("empty positional task read stdin: %v", err)
	}
	for _, tc := range []struct {
		argv        []string
		input, want string
	}{
		{[]string{"argv task"}, "piped task", "argv task"},
		{nil, "piped task", "piped task"},
		{[]string{"-"}, "explicit stdin", "explicit stdin"},
	} {
		cfg, err := cli.ParseSingleConfig(tc.argv)
		if err != nil {
			t.Fatal(err)
		}
		stdinReader = strings.NewReader(tc.input)
		got, _, err := resolveSingleTaskText(rt.Command{Task: cfg.Task, TaskProvided: cfg.TaskProvided, ExplicitStdin: cfg.ExplicitStdin})
		if err != nil || got != tc.want {
			t.Fatalf("%v: got %q, %v", tc.argv, got, err)
		}
	}
}

func regressionPreset(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	dir := filepath.Join(home, ".codeagent")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	data := []byte("{\"agents\":{\"preset\":{\"backend\":\"claude\",\"model\":\"preset-model\",\"reasoning\":\"high\",\"yolo\":true}}}")
	if err := os.WriteFile(filepath.Join(dir, "models.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	config.ResetModelsConfigCacheForTest()
	t.Cleanup(config.ResetModelsConfigCacheForTest)
	return home
}

func regressionParallelPlan(t *testing.T, flags []string, configPath, task string) rs.Plan {
	t.Helper()
	cmd := &cobra.Command{}
	opts := &cli.Options{}
	cli.AddRootFlags(cmd.Flags(), opts)
	if err := cmd.ParseFlags(flags); err != nil {
		t.Fatal(err)
	}
	v, err := config.NewViper(configPath)
	if err != nil {
		t.Fatal(err)
	}
	input, err := cli.BuildParallelInput(cmd, opts, v, cli.ParallelInputDeps{
		StdinReader: strings.NewReader(task), DefaultBackendName: "codex",
		ResolveMaxWorkers: func(_ *viper.Viper) int { return 10 },
	})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := rs.BuildPlan(input, rs.BuildDeps{
		ResolveBackendName: func(s string) (string, error) {
			b, err := selectBackend(s)
			if err != nil {
				return "", err
			}
			return b.Name(), nil
		},
		ParseConfig: rs.ParseConfig, TopologicalSort: dt.TopologicalSort,
	})
	if err != nil {
		t.Fatal(err)
	}
	return plan
}

func TestClaudeExplicitPermissionPriority(t *testing.T) {
	defer resetTestHooks()
	home := regressionPreset(t)
	path := filepath.Join(home, "settings.yaml")
	for _, tc := range []struct {
		name, conf, env, field string
		flags                  []string
		parallel, want         bool
	}{
		{name: "default remains on", want: true},
		{name: "config false", conf: "skip-permissions: false\n"},
		{name: "env overrides config false", conf: "skip-permissions: false\n", env: "true", want: true},
		{name: "env false overrides config true and preset yolo", conf: "skip-permissions: true\n", env: "false"},
		{name: "flag false overrides env true and preset yolo", env: "true", flags: []string{"--skip-permissions=false"}},
		{name: "alias false overrides env true", env: "true", flags: []string{"--dangerously-skip-permissions=false"}},
		{name: "flag true overrides env false", env: "false", flags: []string{"--skip-permissions=true"}, want: true},
		{name: "parallel config false", conf: "skip-permissions: false\n", parallel: true},
		{name: "task false overrides env true", env: "true", field: "skip_permissions: false\n", parallel: true},
		{name: "task false overrides config true", conf: "skip-permissions: true\n", field: "skip-permissions: false\n", parallel: true},
		{name: "task true overrides env false", env: "false", field: "skip_permissions: true\n", parallel: true, want: true},
		{name: "global flag false overrides task true", env: "true", flags: []string{"--skip-permissions=false"}, field: "skip_permissions: true\n", parallel: true},
		{name: "global flag true overrides task false", env: "false", flags: []string{"--skip-permissions"}, field: "skip_permissions: false\n", parallel: true, want: true},
		{name: "parallel alias false", env: "true", flags: []string{"--dangerously-skip-permissions=false"}, parallel: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CODEAGENT_SKIP_PERMISSIONS", tc.env)
			if tc.env == "" {
				if err := os.Unsetenv("CODEAGENT_SKIP_PERMISSIONS"); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(path, []byte(tc.conf), 0600); err != nil {
				t.Fatal(err)
			}
			var spec rt.Spec
			if tc.parallel {
				plan := regressionParallelPlan(t, tc.flags, path, "id: a\nagent: preset\n"+tc.field+"---CONTENT---\ntask")
				spec = plan.Layers[0][0]
			} else {
				flags := append([]string{"--config", path, "--agent", "preset"}, tc.flags...)
				cfg, err := cli.ParseSingleConfig(append(flags, "task"))
				if err != nil {
					t.Fatal(err)
				}
				if _, err := configureSingleModeBackend(cfg); err != nil {
					t.Fatal(err)
				}
				plan, err := rt.PrepareConfigPlan(cfg, rt.PrepareDeps{
					ResolveTaskText:      resolveSingleTaskText,
					ApplyPromptAndSkills: func(_ rt.Command, s string) (string, error) { return s, nil },
					ShouldUseStdin:       func(string, bool) bool { return false }, BuildCommandArgs: buildSingleTaskCommandArgs,
				})
				if err != nil {
					t.Fatal(err)
				}
				spec = plan.TaskSpec
				preview := strings.Contains(strings.Join(plan.Command, " "), "--dangerously-skip-permissions")
				if preview != tc.want {
					t.Fatalf("preview args %v, want bypass=%v", plan.Command, tc.want)
				}
			}
			var args []string
			restore := executor.SetNewCommandRunner(func(_ context.Context, _ string, a ...string) executor.CommandRunner {
				args = append([]string(nil), a...)
				return newFakeCmd(fakeCmdConfig{StdoutPlan: []fakeStdoutEvent{{Data: "{\"type\":\"result\",\"result\":\"done\"}\n"}}})
			})
			defer restore()
			result := executor.RunCodexTaskWithContext(context.Background(), spec, ClaudeBackend{}, "", nil, nil, false, true, 0)
			if result.ExitCode != 0 {
				t.Fatalf("execution: %+v", result)
			}
			got := strings.Contains(strings.Join(args, " "), "--dangerously-skip-permissions")
			if got != tc.want {
				t.Fatalf("args %v, want bypass=%v; spec=%+v", args, tc.want, spec)
			}
		})
	}
}

func TestBackendCasePreservesPreset(t *testing.T) {
	regressionPreset(t)
	cfg, err := cli.ParseSingleConfig([]string{"--backend", "Claude", "--agent", "preset", "task"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Backend != "claude" || cfg.Model != "preset-model" || cfg.ReasoningEffort != "high" || !cfg.Yolo {
		t.Fatalf("single: %+v", cfg)
	}
	plan := regressionParallelPlan(t, []string{"--backend", "Claude"}, "", "id: a\nagent: preset\nbackend: CLAUDE\n---CONTENT---\ntask")
	spec := plan.Layers[0][0]
	if spec.Backend != "claude" || spec.Model != "preset-model" || spec.ReasoningEffort != "high" || !spec.Yolo {
		t.Fatalf("parallel: %+v", spec)
	}
}

func TestParallelBackendModelPriority(t *testing.T) {
	home := regressionPreset(t)
	path := filepath.Join(home, "settings.yaml")
	if err := os.WriteFile(path, []byte("backend: codex\nmodel: config-model\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name                                                 string
		flags                                                []string
		fields, envBackend, envModel, backend, model, reason string
		yolo                                                 bool
	}{
		{name: "preset beats env", fields: "agent: preset\n", envBackend: "gemini", envModel: "env-model", backend: "claude", model: "preset-model", reason: "high", yolo: true},
		{name: "CLI model beats preset", flags: []string{"--model", "cli-model"}, fields: "agent: preset\n", backend: "claude", model: "cli-model", reason: "high", yolo: true},
		{name: "CLI backend beats preset", flags: []string{"--backend", "Codex"}, fields: "agent: preset\n", envModel: "env-model", backend: "codex", model: "env-model"},
		{name: "task fields beat CLI", flags: []string{"--backend", "codex", "--model", "cli-model"}, fields: "agent: preset\nbackend: Claude\nmodel: task-model\n", backend: "claude", model: "task-model", reason: "high", yolo: true},
		{name: "task model survives CLI backend", flags: []string{"--backend", "codex"}, fields: "agent: preset\nmodel: task-model\n", backend: "codex", model: "task-model"},
		{name: "CLI model applies with task backend", flags: []string{"--backend", "codex", "--model", "cli-model"}, fields: "agent: preset\nbackend: claude\n", backend: "claude", model: "cli-model", reason: "high", yolo: true},
		{name: "env beats config", envBackend: "gemini", envModel: "env-model", backend: "gemini", model: "env-model"},
		{name: "config fallback", backend: "codex", model: "config-model"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CODEAGENT_BACKEND", tc.envBackend)
			t.Setenv("CODEAGENT_MODEL", tc.envModel)
			spec := regressionParallelPlan(t, tc.flags, path, "id: a\n"+tc.fields+"---CONTENT---\ntask").Layers[0][0]
			if spec.Backend != tc.backend || spec.Model != tc.model || spec.ReasoningEffort != tc.reason || spec.Yolo != tc.yolo {
				t.Fatalf("got %+v; want %s/%s/%s yolo=%v", spec, tc.backend, tc.model, tc.reason, tc.yolo)
			}
		})
	}
}

func TestCleanupResolvesTaskTempDir(t *testing.T) {
	defer resetTestHooks()
	restore := captureTempEnv()
	defer restore()
	override := t.TempDir()
	t.Setenv("CODEAGENT_TMPDIR", override)
	origCheck := tmpDirExecutableCheckFn
	tmpDirExecutableCheckFn = func(string) (bool, error) { return true, nil }
	defer func() { tmpDirExecutableCheckFn = origCheck }()
	for _, arg := range []string{"cleanup", "--cleanup"} {
		t.Run(arg, func(t *testing.T) {
			setTempDirEnv(t, t.TempDir())
			called := false
			cleanupLogsFn = func() (CleanupStats, error) {
				called = true
				if got := os.TempDir(); filepath.Clean(got) != filepath.Clean(override) {
					t.Errorf("temp dir=%q, want %q", got, override)
				}
				return CleanupStats{}, nil
			}
			cmd := newRootCommand()
			cmd.SetArgs([]string{arg})
			if err := cmd.Execute(); err != nil {
				t.Fatal(err)
			}
			if !called {
				t.Fatal("cleanup did not run")
			}
		})
	}
}
