package runtask

import (
	"context"
)

// Spec carries application/runtime execution details for a task.
type Spec struct {
	ID                 string
	Task               string
	Dependencies       []string
	WorkDir            string
	SessionID          string
	Backend            string
	BackendExplicit    bool
	ModelExplicit      bool
	ReasoningExplicit  bool
	PresetBackend      string // Backend for inherited model/reasoning/yolo settings.
	Model              string
	ReasoningEffort    string
	Agent              string
	PromptFileExplicit bool
	PromptFile         string
	Yolo               bool
	SkipPermissions    bool
	SkipPermissionsSet bool // Distinguishes an explicit false from an unset value.
	Worktree           bool
	AllowedTools       []string
	DisallowedTools    []string
	Skills             []string
	Mode               string
	UseStdin           bool
	Context            context.Context
}
