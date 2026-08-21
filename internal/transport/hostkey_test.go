package transport

import (
	"context"
	"errors"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestUnknownHostIsReportedWithFingerprint(t *testing.T) {
	srv := newTestServer(t, map[string]testReply{})
	defer srv.Close()

	// Политика, изображающая пустой known_hosts.
	policy := func(hostport string, key ssh.PublicKey) error {
		return &ErrHostKeyUnknown{Host: hostport, Fingerprint: ssh.FingerprintSHA256(key)}
	}

	_, err := Dial(context.Background(), srv.Config(), policy)
	var unknown *ErrHostKeyUnknown
	if !errors.As(err, &unknown) {
		t.Fatalf("ожидалась ErrHostKeyUnknown, получено %v", err)
	}
	if unknown.Fingerprint == "" {
		t.Fatal("отпечаток пуст, показывать пользователю нечего")
	}
}
