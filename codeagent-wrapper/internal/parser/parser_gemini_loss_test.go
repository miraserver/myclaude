package parser

import (
	"strings"
	"testing"
)

func TestGeminiDroppedJSONBetweenDeltas(t *testing.T) {
	first := `{"type":"message","role":"assistant","delta":true,"content":"first"}`
	second := `{"type":"message","role":"assistant","delta":true,"content":"second"}`
	result := `{"type":"result","status":"success"}`
	for _, drop := range []struct{ name, line string }{
		{"malformed", "{"},
		{"overlong", "{" + strings.Repeat("x", jsonLineMaxBytes)},
	} {
		for _, tc := range []struct {
			name  string
			lines []string
			fail  bool
		}{
			{"between deltas stays lost", []string{first, drop.line, second, result}, true},
			{"after completion ignored", []string{first, second, result, drop.line}, false},
			{"before first delta repaired by accepted content", []string{drop.line, first, second, result}, false},
		} {
			t.Run(drop.name+"/"+tc.name, func(t *testing.T) {
				msg, _, err := ParseJSONStreamWithError(strings.NewReader(strings.Join(tc.lines, "\n")), nil, nil, nil, nil)
				if msg != "firstsecond" || (err != nil) != tc.fail {
					t.Fatalf("msg=%q err=%v wantFailure=%t", msg, err, tc.fail)
				}
				if err != nil && err.Error() != "backend output truncated/unparsable; final message may be lost" {
					t.Fatal(err)
				}
			})
		}
	}
}
