//go:build windows

package executor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWindowsShimRejectsUnsafeArgumentsBeforeStart(t *testing.T) {
	for _, ext := range []string{".cmd", ".bat"} {
		t.Run(ext, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "wrapper-shim"+ext), []byte("@exit /b 0\r\n"), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", dir)
			t.Setenv("PATHEXT", ".COM;.EXE;.BAT;.CMD")
			restore := SetNewCommandRunner(func(context.Context, string, ...string) CommandRunner {
				t.Fatal("created runner for unsafe shim argv")
				return nil
			})
			defer restore()
			for _, char := range "&|<>^%!\"" {
				arg := "model" + string(char) + "value"
				res := RunCodexTaskWithContext(context.Background(), TaskSpec{Task: "safe"}, nil, "wrapper-shim", nil, []string{"--model", arg, "safe"}, true, true, 0)
				if res.ExitCode != 1 || !strings.Contains(res.Error, "argument 2") || !strings.Contains(res.Error, "model") {
					t.Fatalf("%q: %+v", arg, res)
				}
			}
		})
	}
}
