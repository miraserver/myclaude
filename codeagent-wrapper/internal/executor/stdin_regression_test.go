package executor

import "testing"

func TestStdinForCmdMetacharactersAndLeadingDash(t *testing.T) {
	for _, char := range "&|<>^%!\"\n" {
		task := "task" + string(char) + "text"
		if !ShouldUseStdin(task, false) {
			t.Errorf("task %q was passed as argv", task)
		}
	}
	if !ShouldUseStdin("- task", false) {
		t.Fatal("leading dash task passed as argv")
	}
	if ShouldUseStdin("safe task", false) {
		t.Fatal("safe task unnecessarily uses stdin")
	}
}
