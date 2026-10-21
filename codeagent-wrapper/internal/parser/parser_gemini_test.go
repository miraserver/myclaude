package parser

import (
	"strings"
	"testing"
)

func TestGeminiIgnoresPromptAndSystemContent(t *testing.T) {
	stream := strings.Join([]string{
		`{"type":"init","session_id":"gemini-session"}`,
		`{"type":"message","role":"user","content":"SECRET"}`,
		`{"type":"message","role":"system","content":"SYSTEM SECRET"}`,
		`{"type":"message","role":"assistant","delta":true,"content":"ans"}`,
		`{"type":"message","role":"assistant","delta":true,"content":"wer"}`,
		`{"type":"result","status":"success"}`,
	}, "\n")
	message, session := ParseJSONStreamInternal(strings.NewReader(stream), nil, nil, nil, nil)
	if message != "answer" || session != "gemini-session" {
		t.Fatalf("got message=%q session=%q", message, session)
	}
}
