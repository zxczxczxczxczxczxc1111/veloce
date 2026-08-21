package collect

import (
	"testing"
	"time"
)

func TestParseUptime(t *testing.T) {
	got, err := ParseUptime("350735.47 234388.90\n")
	if err != nil {
		t.Fatalf("ParseUptime: %v", err)
	}
	if got.Truncate(time.Second) != 350735*time.Second {
		t.Fatalf("получено %v", got)
	}
}
