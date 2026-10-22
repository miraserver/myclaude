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
