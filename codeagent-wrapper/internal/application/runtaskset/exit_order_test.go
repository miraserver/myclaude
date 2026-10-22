package runtaskset

import (
	rt "codeagent-wrapper/internal/application/runtask"
	dt "codeagent-wrapper/internal/domain/task"
	"context"
	"testing"
)

func TestExitCodeUsesDefinitionOrderAcrossDependencyLayers(t *testing.T) {
	plan, err := BuildPlan(BuildInput{BackendName: "codex", StdinData: []byte("id: first\ndependencies: second\n---CONTENT---\na\n---TASK---\nid: second\n---CONTENT---\nb")}, BuildDeps{
		ResolveBackendName: func(s string) (string, error) { return s, nil }, ParseConfig: ParseConfig, TopologicalSort: dt.TopologicalSort,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, results := range [][]dt.TaskResult{
		{{TaskID: "second", ExitCode: 7}, {TaskID: "first", ExitCode: 3}},
		{{TaskID: "first", ExitCode: 3}, {TaskID: "second", ExitCode: 7}},
	} {
		_, code, err := RunPlan(context.Background(), plan, RunDeps{
			ExecuteConcurrent: func(context.Context, [][]rt.Spec, int) []dt.TaskResult { return results }, EnrichResults: func([]dt.TaskResult) {}, RenderFinalOutputWithMode: func([]dt.TaskResult, bool) string { return "" },
		})
		if err != nil || code != 3 {
			t.Fatalf("exit=%d error=%v", code, err)
		}
	}
}
