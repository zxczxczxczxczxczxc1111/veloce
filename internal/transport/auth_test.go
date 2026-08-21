package transport

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

// rejectingServer поднимает SSH-сервер, который отвергает любой ключ. Нужен
// потому, что обычный тестовый сервер пускает всех: отказ аутентификации на
// нём не воспроизвести вовсе.
func rejectingServer(t *testing.T) (string, string) {
	t.Helper()

	host, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(host)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) {
			return nil, fmt.Errorf("ключ не разрешён")
		},
	}
	cfg.AddHostKey(signer)

	client, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "id_rsa")
	err = os.WriteFile(keyPath, encodePEM(x509.MarshalPKCS1PrivateKey(client)), 0o600)
	if err != nil {
		t.Fatal(err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				_, _, _, _ = ssh.NewServerConn(c, cfg)
				c.Close()
			}()
		}
	}()
	return ln.Addr().String(), keyPath
}

func TestAuthErrorNamesAccountHostAndKey(t *testing.T) {
	addr, keyPath := rejectingServer(t)
	host, portStr, _ := net.SplitHostPort(addr)
	port := 0
	fmt.Sscanf(portStr, "%d", &port)

	cfg := Config{Host: host, Port: port, User: "nosuchuser", KeyPath: keyPath}
	accept := func(string, ssh.PublicKey) error { return nil }

	_, err := Dial(context.Background(), cfg, accept)
	if err == nil {
		t.Fatal("сервер, отвергающий все ключи, пустил внутрь")
	}
	msg := err.Error()

	// «Ключ не принят» без учётной записи заставляет искать вслепую. Человек,
	// вписавший в поле пользователя имя файла ключа, обязан увидеть это прямо
	// в сообщении, а не гадать, что именно сервер отверг.
	if !strings.Contains(msg, "nosuchuser@") {
		t.Fatalf("в сообщении нет учётной записи: %s", msg)
	}
	if !strings.Contains(msg, host) {
		t.Fatalf("в сообщении нет хоста: %s", msg)
	}
	if !strings.Contains(msg, keyPath) {
		t.Fatalf("в сообщении нет ключа, которым пробовали: %s", msg)
	}
	// Разбор причины обязан пережить обёртку: иначе интерфейс покажет
	// «связи нет» там, где ключ не принят, и предложит ждать переподключения.
	if got := StateForError(err); got != StateAuthFailed {
		t.Fatalf("состояние %v, ожидалось StateAuthFailed", got)
	}
}

func TestAgentPipeIsAValidWindowsPipePath(t *testing.T) {
	// Именованный канал Windows начинается с ДВУХ обратных косых: \\.\pipe\.
	// С одной DialPipe не найдёт агент никогда, и галочка «Агент OpenSSH» в
	// форме будет вечно отвечать «агент недоступен» даже на живой службе.
	const want = `\\.\pipe\`
	if !strings.HasPrefix(agentPipe, want) {
		t.Fatalf("путь к агенту %q не начинается с %q", agentPipe, want)
	}
}
