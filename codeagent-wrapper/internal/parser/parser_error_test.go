package parser

import (
	"strings"
	"testing"
)

func TestOpenCodeErrorsRemainFailuresAfterLaterText(t *testing.T) {
	for _, payload := range []string{
		`"backend failed"`,
		`{"message":"backend failed"}`,
		`{"name":"APIError","data":{"message":"backend failed"}}`,
	} {
		input := `{"type":"error","sessionID":"s","error":` + payload + `}` + "\n" +
			`{"type":"text","sessionID":"s","part":{"type":"text","text":"later"}}` + "\n" +
			`{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","reason":"stop"}}`
		msg, session, err := ParseJSONStreamWithError(strings.NewReader(input), nil, nil, nil, nil)
		if msg != "later" || session != "s" || err == nil || !strings.Contains(err.Error(), "backend failed") {
			t.Fatalf("msg=%q session=%q err=%v", msg, session, err)
		}
	}
}

func TestDroppedFinalLineAtReaderBoundary(t *testing.T) {
	// An exact multiple of the reader size makes the next ReadLine return EOF.
	input := `{"type":"item.completed","item":{"type":"agent_message","text":"interim"}}` + "\n" +
		"{" + strings.Repeat("x", 11*1024*1024-1)
	msg, _, err := ParseJSONStreamWithError(strings.NewReader(input), nil, nil, nil, nil)
	if msg != "interim" || err == nil {
		t.Fatalf("msg=%q err=%v", msg, err)
	}
}

func TestNonCompletionStatusDoesNotRepairDroppedJSON(t *testing.T) {
	input := `{"type":"message","role":"assistant","content":"interim"}` + "\n" +
		`{"type":` + "\n" + `{"type":"progress","status":"running"}`
	_, _, err := ParseJSONStreamWithError(strings.NewReader(input), nil, nil, nil, nil)
	if err == nil {
		t.Fatal("progress status cleared dropped JSON failure")
	}
}

func TestDroppedJSONCompletionOrdering(t *testing.T) {
	oversized := `{"type":"tool_output","text":"` + strings.Repeat("x", jsonLineMaxBytes) + `"}`
	for _, backend := range []struct {
		name, message, completion string
		appendText                bool
	}{
		{"codex", `{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}`, `{"type":"turn.completed"}`, false},
		{"claude", `{"type":"assistant","result":"answer"}`, `{"type":"result","session_id":"s"}`, false},
		{"gemini", `{"type":"message","role":"assistant","content":"answer"}`, `{"type":"result","status":"success"}`, true},
		{"opencode", `{"type":"text","sessionID":"s","part":{"type":"text","text":"answer"}}`, `{"type":"step_finish","sessionID":"s","part":{"type":"step-finish","reason":"stop"}}`, true},
	} {
		t.Run(backend.name, func(t *testing.T) {
			m, c := backend.message, backend.completion
			for _, tc := range []struct {
				name  string
				lines []string
				fail  bool
				twice bool
			}{
				{"drop without completion", []string{m, "{"}, true, false},
				{"drop then completion", []string{m, "{", c}, true, false},
				{"overlong then completion", []string{m, oversized, c}, true, false},
				{"repeated completion preserves loss", []string{m, "{", c, c}, true, false},
				{"diagnostic after completion", []string{m, c, "{diagnostic"}, false, false},
				{"brace after completion", []string{m, c, "{"}, false, false},
				{"overlong after completion", []string{m, c, oversized}, false, false},
				{"trailing noise then completion", []string{m, c, "{", c}, false, false},
				{"later message repairs loss", []string{m, "{", c, m}, false, true},
				{"overlong tool output between messages", []string{m, oversized, m, c}, false, true},
				{"later message requires new completion", []string{m, c, m, "{"}, true, true},
			} {
				t.Run(tc.name, func(t *testing.T) {
					msg, _, err := ParseJSONStreamWithError(strings.NewReader(strings.Join(tc.lines, "\n")), nil, nil, nil, nil)
					want := "answer"
					if tc.twice && backend.appendText {
						want += "answer"
					}
					if msg != want || (err != nil) != tc.fail {
						t.Fatalf("msg=%q want=%q err=%v wantFailure=%t", msg, want, err, tc.fail)
					}
				})
			}
		})
	}
}

func TestClaudeResultIgnoresTrailingJSONNoise(t *testing.T) {
	input := `{"type":"result","result":"final","session_id":"s"}` + "\n{"
	msg, session, err := ParseJSONStreamWithError(strings.NewReader(input), nil, nil, nil, nil)
	if msg != "final" || session != "s" || err != nil {
		t.Fatalf("msg=%q session=%q err=%v", msg, session, err)
	}
}
