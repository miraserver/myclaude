package runtaskset

import (
	"context"
	"fmt"
	"strings"

	appoutput "codeagent-wrapper/internal/application/output"
	appruntask "codeagent-wrapper/internal/application/runtask"
	domaintask "codeagent-wrapper/internal/domain/task"
)

type Plan struct {
	TaskOrder   []string
	OutputPath  string
	SummaryOnly bool
	Layers      [][]appruntask.Spec
	MaxWorkers  int
}

type ParallelConfig struct {
	Tasks         []appruntask.Spec
	GlobalBackend string
}

type BuildInput struct {
	BackendName        string
	Model              string
	OutputPath         string
	SummaryOnly        bool
	SkipPermissions    bool
	StdinData          []byte
	MaxWorkers         int
	ReasoningEffort    string
	PromptFileOverride bool // A CLI flag takes priority over agent presets.
	PromptFile         string
}

type BuildDeps struct {
	ResolveBackendName func(string) (string, error)
	ParseConfig        func([]byte) (*ParallelConfig, error)
	TopologicalSort    func([]domaintask.TaskSpec) ([][]domaintask.TaskSpec, error)
}

type RunDeps struct {
	ExecuteConcurrent         func(context.Context, [][]appruntask.Spec, int) []domaintask.TaskResult
	EnrichResults             func([]domaintask.TaskResult)
	RenderFinalOutputWithMode func([]domaintask.TaskResult, bool) string
}

func BuildPlan(input BuildInput, deps BuildDeps) (Plan, error) {
	backendName, err := deps.ResolveBackendName(input.BackendName)
	if err != nil {
		return Plan{}, err
	}

	cfg, err := deps.ParseConfig(input.StdinData)
	if err != nil {
		return Plan{}, err
	}

	cfg.GlobalBackend = backendName
	model := strings.TrimSpace(input.Model)
	for i := range cfg.Tasks {
		if strings.TrimSpace(cfg.Tasks[i].Backend) == "" {
			cfg.Tasks[i].Backend = backendName
		}
		if strings.TrimSpace(cfg.Tasks[i].Model) == "" && model != "" && cfg.Tasks[i].Backend == backendName {
			cfg.Tasks[i].Model = model
		}
		if strings.TrimSpace(cfg.Tasks[i].ReasoningEffort) == "" {
			cfg.Tasks[i].ReasoningEffort = input.ReasoningEffort
		}
		if input.PromptFileOverride || strings.TrimSpace(cfg.Tasks[i].PromptFile) == "" {
			cfg.Tasks[i].PromptFile = input.PromptFile
			cfg.Tasks[i].PromptFileExplicit = strings.TrimSpace(input.PromptFile) != ""
		}
		cfg.Tasks[i].SkipPermissions = cfg.Tasks[i].SkipPermissions || input.SkipPermissions
	}

	domainTasks := make([]domaintask.TaskSpec, len(cfg.Tasks))
	byID := make(map[string]appruntask.Spec, len(cfg.Tasks))
	for i := range cfg.Tasks {
		domainTasks[i] = domaintask.TaskSpec{
			ID:           cfg.Tasks[i].ID,
			Task:         cfg.Tasks[i].Task,
			Dependencies: append([]string(nil), cfg.Tasks[i].Dependencies...),
		}
		byID[cfg.Tasks[i].ID] = cfg.Tasks[i]
	}

	sorted, err := deps.TopologicalSort(domainTasks)
	if err != nil {
		return Plan{}, err
	}

	layers := make([][]appruntask.Spec, len(sorted))
	for i := range sorted {
		layers[i] = make([]appruntask.Spec, len(sorted[i]))
		for j := range sorted[i] {
			layers[i][j] = byID[sorted[i][j].ID]
		}
	}

	order := make([]string, len(cfg.Tasks))
	for i, task := range cfg.Tasks {
		order[i] = task.ID
	}
	return Plan{
		TaskOrder:   order,
		OutputPath:  input.OutputPath,
		SummaryOnly: input.SummaryOnly,
		Layers:      layers,
		MaxWorkers:  input.MaxWorkers,
	}, nil
}

func RunPlan(parentCtx context.Context, plan Plan, deps RunDeps) (string, int, error) {
	results := deps.ExecuteConcurrent(parentCtx, plan.Layers, plan.MaxWorkers)
	deps.EnrichResults(results)

	if err := appoutput.WriteStructuredOutput(plan.OutputPath, results); err != nil {
		return "", 0, err
	}

	exitCode := 0
	resultByID := make(map[string]domaintask.TaskResult, len(results))
	for _, res := range results {
		resultByID[res.TaskID] = res
	}
	order := plan.TaskOrder
	if len(order) == 0 {
		for _, layer := range plan.Layers {
			for _, task := range layer {
				order = append(order, task.ID)
			}
		}
	}
	for _, id := range order {
		res, ok := resultByID[id]
		if !ok || (res.ExitCode == 0 && res.Error == "") {
			continue
		}
		exitCode = res.ExitCode
		if exitCode < 1 {
			exitCode = 1
		}
		break
	}

	return deps.RenderFinalOutputWithMode(results, plan.SummaryOnly), exitCode, nil
}

func PanicTaskResult(taskID string, recovered any) domaintask.TaskResult {
	return domaintask.TaskResult{TaskID: taskID, ExitCode: 1, Error: fmt.Sprintf("panic: %v", recovered)}
}
