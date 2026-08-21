package transport

import (
	"context"
	"testing"
	"time"
)

func TestRunReturnsStdoutAndCode(t *testing.T) {
	srv := newTestServer(t, map[string]testReply{
		"echo hi": {stdout: "hi\n", code: 0},
		"missing": {stderr: "not found\n", code: 127},
	})
	defer srv.Close()

	conn, err := Dial(context.Background(), srv.Config(), AcceptAny())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	got, err := conn.Run(context.Background(), "echo hi")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got.Stdout != "hi\n" || got.Code != 0 {
		t.Fatalf("получено %+v", got)
	}

	// Ненулевой код это не ошибка транспорта: связь цела, команда отработала.
	bad, err := conn.Run(context.Background(), "missing")
	if err != nil {
		t.Fatalf("Run с ненулевым кодом не должен возвращать ошибку: %v", err)
	}
	if bad.Code != 127 {
		t.Fatalf("код %d, ожидался 127", bad.Code)
	}
}

func TestStreamDeliversOutput(t *testing.T) {
	srv := newTestServer(t, map[string]testReply{
		"tail": {stdout: "one\ntwo\n", code: 0},
	})
	defer srv.Close()

	conn, err := Dial(context.Background(), srv.Config(), AcceptAny())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer conn.Close()

	rc, err := conn.Stream(context.Background(), "tail")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer rc.Close()

	buf := make([]byte, 64)
	n, _ := rc.Read(buf)
	if string(buf[:n]) != "one\ntwo\n" {
		t.Fatalf("получено %q", string(buf[:n]))
	}
}

func TestRunReconnectsAfterDrop(t *testing.T) {
	srv := newTestServer(t, map[string]testReply{
		"echo hi": {stdout: "hi\n", code: 0},
	})
	defer srv.Close()

	cn, err := Dial(context.Background(), srv.Config(), AcceptAny())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer cn.Close()

	if _, err := cn.Run(context.Background(), "echo hi"); err != nil {
		t.Fatalf("первый Run: %v", err)
	}

	// Роняем соединение изнутри, имитируя обрыв сети.
	// Переменная называется cn, а не conn: локальная conn затенила бы пакетный
	// тип conn, и утверждение типа `conn.(*conn)` перестало бы компилироваться
	// с ошибкой «conn is not a type».
	impl := cn.(*conn)
	impl.mu.Lock()
	impl.client.Close()
	impl.client = nil
	impl.state = StateDisconnected
	impl.backoff = 10 * time.Millisecond // не ждать секунду в тесте
	impl.mu.Unlock()

	// Следующая команда обязана переподключиться сама, а не вернуть ошибку.
	got, err := cn.Run(context.Background(), "echo hi")
	if err != nil {
		t.Fatalf("после обрыва Run должен переподключиться, получено: %v", err)
	}
	if got.Stdout != "hi\n" {
		t.Fatalf("получено %q", got.Stdout)
	}
	if cn.State() != StateConnected {
		t.Fatalf("состояние %v, ожидалось StateConnected", cn.State())
	}
}

func TestClosedConnDoesNotReconnect(t *testing.T) {
	srv := newTestServer(t, map[string]testReply{"echo hi": {stdout: "hi\n"}})
	defer srv.Close()

	cn, _ := Dial(context.Background(), srv.Config(), AcceptAny())
	cn.Close()

	// Пользователь закрыл соединение намеренно. Воскрешать его нельзя.
	if _, err := cn.Run(context.Background(), "echo hi"); err == nil {
		t.Fatal("закрытое соединение переподключилось само")
	}
}

func TestStreamEndsWhenServerGoesAway(t *testing.T) {
	srv := newTestServer(t, map[string]testReply{"tail": {stdout: "one\n", hold: true}})
	cn, err := Dial(context.Background(), srv.Config(), AcceptAny())
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer cn.Close()

	rc, err := cn.Stream(context.Background(), "tail")
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	defer rc.Close()

	srv.Close() // сервер ушёл посреди стрима

	// Читатель обязан получить конец потока, а не зависнуть навсегда.
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 64)
		for {
			if _, err := rc.Read(buf); err != nil {
				close(done)
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("чтение из оборванного стрима не завершилось")
	}
}

func TestAuthFailureIsNotRetried(t *testing.T) {
	srv := newTestServer(t, map[string]testReply{})
	defer srv.Close()

	cfg := srv.Config()
	cfg.KeyPath = ""     // ни ключа
	cfg.UseAgent = false // ни агента

	_, err := Dial(context.Background(), cfg, AcceptAny())
	if err == nil {
		t.Fatal("подключение без единого метода аутентификации не должно удаваться")
	}
	// Ошибка обязана опознаваться как отказ аутентификации, иначе ensure
	// начнёт переподключаться вечно.
	if got := stateForError(err); got != StateAuthFailed {
		t.Fatalf("состояние %v, ожидалось StateAuthFailed", got)
	}
}
