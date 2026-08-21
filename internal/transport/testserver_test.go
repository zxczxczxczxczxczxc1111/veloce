package transport

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"
)

type testReply struct {
	stdout string
	stderr string
	code   int
	// hold оставляет канал открытым после записи stdout: команда изображает
	// `docker logs -f`, то есть висит, пока её не оборвут снаружи. Без этого
	// флага сервер закрывает канал сразу, читатель получает EOF по штатному
	// завершению команды, и тест на обрыв связи проходит вообще без обрыва.
	hold bool
}

type testServer struct {
	ln      net.Listener
	replies map[string]testReply
	keyPath string

	// Живые соединения. Close закрывает их вместе со слушателем: закрытие
	// одного слушателя обрывает только новые подключения, а уже поднятая
	// сессия продолжает жить, и «сервер ушёл» получается ненастоящим.
	mu    sync.Mutex
	conns []net.Conn
}

func newTestServer(t *testing.T, replies map[string]testReply) *testServer {
	t.Helper()

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("генерация ключа: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}

	cfg := &ssh.ServerConfig{NoClientAuth: true}
	cfg.AddHostKey(signer)

	// Клиентский ключ пишется во временный файл теста. Без него authMethods
	// возвращает «не указан ни ключ, ни агент», Dial падает ещё до сети, и ни
	// один тест этого пакета не проходит. Сервер принимает любой ключ
	// (NoClientAuth), важен только сам факт наличия метода.
	clientKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("генерация клиентского ключа: %v", err)
	}
	der := x509.MarshalPKCS1PrivateKey(clientKey)
	keyPath := filepath.Join(t.TempDir(), "id_rsa")
	err = os.WriteFile(keyPath, encodePEM(der), 0o600)
	if err != nil {
		t.Fatalf("запись клиентского ключа: %v", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &testServer{ln: ln, replies: replies, keyPath: keyPath}
	go s.serve(cfg)
	return s
}

func encodePEM(der []byte) []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: der})
}

func (s *testServer) serve(cfg *ssh.ServerConfig) {
	for {
		nConn, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conns = append(s.conns, nConn)
		s.mu.Unlock()
		go s.handle(nConn, cfg)
	}
}

func (s *testServer) handle(nConn net.Conn, cfg *ssh.ServerConfig) {
	_, chans, reqs, err := ssh.NewServerConn(nConn, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)

	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			newCh.Reject(ssh.UnknownChannelType, "only sessions")
			continue
		}
		ch, chReqs, err := newCh.Accept()
		if err != nil {
			continue
		}
		go func() {
			for req := range chReqs {
				if req.Type != "exec" {
					req.Reply(false, nil)
					continue
				}
				// Полезная нагрузка exec: 4 байта длины, дальше команда.
				cmd := string(req.Payload[4:])
				req.Reply(true, nil)

				reply, ok := s.replies[cmd]
				if !ok {
					reply = testReply{stderr: "unexpected: " + cmd + "\n", code: 1}
				}
				ch.Write([]byte(reply.stdout))
				ch.Stderr().Write([]byte(reply.stderr))

				if reply.hold {
					// Команда не завершается сама. Канал закроется только
					// вместе с соединением, то есть по Close сервера.
					continue
				}

				status := struct{ Status uint32 }{uint32(reply.code)}
				ch.SendRequest("exit-status", false, ssh.Marshal(&status))
				ch.Close()
			}
		}()
	}
}

func (s *testServer) Config() Config {
	addr := s.ln.Addr().(*net.TCPAddr)
	return Config{Host: "127.0.0.1", Port: addr.Port, User: "test", KeyPath: s.keyPath}
}

func (s *testServer) Close() {
	s.ln.Close()
	s.mu.Lock()
	conns := s.conns
	s.conns = nil
	s.mu.Unlock()
	for _, c := range conns {
		c.Close()
	}
}

// AcceptAny отключает проверку ключа хоста. Живёт ТОЛЬКО в тестовом файле:
// в обычном файле пакета она попала бы в продакшн-бинарник, а экспортированный
// выключатель защиты от подмены хоста это дефект, а не удобство. Комментарий
// «только для тестов» ничего не гарантирует, суффикс _test.go гарантирует.
func AcceptAny() HostKeyPolicy {
	return func(string, ssh.PublicKey) error { return nil }
}

// Fingerprint пригодится тестам на политику ключа хоста.
func fingerprintOf(pub ssh.PublicKey) string {
	return strings.TrimSpace(fmt.Sprint(ssh.FingerprintSHA256(pub)))
}
