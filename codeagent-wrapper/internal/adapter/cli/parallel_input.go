package cli

import (
	"fmt"
	"io"
	"strings"

	runtaskset "codeagent-wrapper/internal/application/runtaskset"

	"github.com/spf13/cobra"
	"github.com/spf13/viper"
)

type ParallelInputDeps struct {
	StdinReader        io.Reader
	DefaultBackendName string
	ResolveMaxWorkers  func(*viper.Viper) int
}

func BuildParallelInput(cmd *cobra.Command, opts *Options, v *viper.Viper, deps ParallelInputDeps) (runtaskset.BuildInput, error) {
	backendName := deps.DefaultBackendName
	if cmd.Flags().Changed("backend") {
		backendName = strings.TrimSpace(opts.Backend)
		if backendName == "" {
			return runtaskset.BuildInput{}, fmt.Errorf("--backend flag requires a value")
		}
	} else if val := strings.TrimSpace(v.GetString("backend")); val != "" {
		backendName = val
	}

	model := ""
	if cmd.Flags().Changed("model") {
		model = strings.TrimSpace(opts.Model)
		if model == "" {
			return runtaskset.BuildInput{}, fmt.Errorf("--model flag requires a value")
		}
	} else {
		model = strings.TrimSpace(v.GetString("model"))
	}

	summaryOnly := !opts.FullOutput
	if !cmd.Flags().Changed("full-output") && v.IsSet("full-output") {
		summaryOnly = !v.GetBool("full-output")
	}

	outputPath := ""
	if cmd.Flags().Changed("output") {
		outputPath = strings.TrimSpace(opts.Output)
		if outputPath == "" {
			return runtaskset.BuildInput{}, fmt.Errorf("--output flag requires a value")
		}
	} else if val := strings.TrimSpace(v.GetString("output")); val != "" {
		outputPath = val
	}

	skipChanged := cmd.Flags().Changed("skip-permissions") || cmd.Flags().Changed("dangerously-skip-permissions")
	skipPermissions := false
	if skipChanged {
		skipPermissions = opts.SkipPermissions
	} else {
		skipPermissions = v.GetBool("skip-permissions")
	}

	promptFile := strings.TrimSpace(v.GetString("prompt-file"))
	if cmd.Flags().Changed("prompt-file") {
		promptFile = strings.TrimSpace(opts.PromptFile)
		if promptFile == "" {
			return runtaskset.BuildInput{}, fmt.Errorf("--prompt-file flag requires a value")
		}
	}

	data, err := io.ReadAll(deps.StdinReader)
	if err != nil {
		return runtaskset.BuildInput{}, fmt.Errorf("failed to read stdin: %w", err)
	}

	return runtaskset.BuildInput{
		BackendName:             strings.ToLower(backendName),
		BackendOverride:         cmd.Flags().Changed("backend"),
		ModelOverride:           cmd.Flags().Changed("model"),
		SkipPermissionsSet:      skipChanged || v.IsSet("skip-permissions"),
		SkipPermissionsOverride: skipChanged,
		Model:                   model,
		OutputPath:              outputPath,
		SummaryOnly:             summaryOnly,
		SkipPermissions:         skipPermissions,
		StdinData:               data,
		MaxWorkers:              deps.ResolveMaxWorkers(v),
		ReasoningEffort:         strings.TrimSpace(v.GetString("reasoning-effort")),
		PromptFile:              promptFile,
		PromptFileOverride:      cmd.Flags().Changed("prompt-file"),
	}, nil
}
