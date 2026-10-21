package worktree

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMockGitHelper(t *testing.T) {
	if value := os.Getenv("MOCK_WORKTREE_GIT"); value != "" {
		fmt.Println(value)
		os.Exit(0)
	}
}
func TestWorktreeProjectDirectory(t *testing.T) {
	for _, mode := range []string{"subdirectory", "symlink", "missing", "outside", "case"} {
		t.Run(mode, func(t *testing.T) {
			defer resetHooks()
			root := t.TempDir()
			project := filepath.Join(root, "sub")
			if err := os.MkdirAll(project, 0755); err != nil {
				t.Fatal(err)
			}
			if mode == "symlink" {
				link := filepath.Join(t.TempDir(), "link")
				if err := os.Symlink(root, link); err != nil {
					t.Skipf("symlinks unavailable: %v", err)
				}
				project = filepath.Join(link, "sub")
			}
			if mode == "outside" {
				project = t.TempDir()
			}
			if mode == "case" {
				if runtime.GOOS != "windows" {
					t.Skip("Windows case comparison")
				}
				project = strings.ToUpper(project)
			}
			calls := 0
			execCommand = func(name string, args ...string) *exec.Cmd {
				calls++
				value := "ok"
				switch calls {
				case 1:
					value = "true"
				case 2:
					value = root
				case 3:
					if name != "git" || args[2] != "worktree" {
						t.Fatalf("unexpected git: %v", args)
					}
					tree := args[len(args)-1]
					if mode != "missing" && mode != "outside" {
						tree = filepath.Join(tree, "sub")
					}
					if err := os.MkdirAll(tree, 0755); err != nil {
						t.Fatal(err)
					}
				default:
					t.Fatal("extra git call")
				}
				cmd := exec.Command(os.Args[0], "-test.run=^TestMockGitHelper$")
				cmd.Env = append(os.Environ(), "MOCK_WORKTREE_GIT="+value, "GORACE=atexit_sleep_ms=0")
				return cmd
			}
			paths, err := CreateWorktree(project)
			if err != nil {
				t.Fatal(err)
			}
			want := paths.Dir
			if mode != "missing" && mode != "outside" {
				want = filepath.Join(want, "sub")
			}
			if calls != 3 || paths.WorkDir != want {
				t.Fatalf("%+v want=%s calls=%d", paths, want, calls)
			}
		})
	}
}
