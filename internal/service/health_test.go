package service

import (
	"strings"
	"testing"
	"time"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

func healthService(t *testing.T, c *recordingConn) *HealthService {
	t.Helper()
	reg := NewConnRegistry()
	reg.Set("srv1", c)
	return NewHealthService(reg)
}

func TestHealthCheckRunsOnTheServer(t *testing.T) {
	c := &recordingConn{res: transport.Result{Stdout: "200\n"}}
	h := healthService(t, c)

	got, err := h.Check("srv1", "http://127.0.0.1:8081/health")
	if err != nil {
		t.Fatal(err)
	}
	if !got.OK || got.Code != 200 {
		t.Fatalf("результат %+v", got)
	}
	// Проверка обязана идти С СЕРВЕРА: адрес на localhost с машины
	// пользователя недостижим по определению, и проверять его отсюда значит
	// всегда получать отказ у совершенно здорового приложения.
	if len(c.cmds) != 1 || !strings.Contains(c.cmds[0], "curl") {
		t.Fatalf("команда не ушла на сервер: %v", c.cmds)
	}
	// Адрес приходит из настроек, то есть введён руками. В команду он обязан
	// попадать в кавычках, иначе точка с запятой в поле это чужая команда на
	// сервере.
	if !strings.Contains(c.cmds[0], "'http://127.0.0.1:8081/health'") {
		t.Fatalf("адрес ушёл в команду без кавычек: %q", c.cmds[0])
	}
}

func TestHealthCodeClassification(t *testing.T) {
	cases := []struct {
		out  string
		code int
		ok   bool
		why  string
	}{
		{"200", 200, true, "обычный ответ"},
		{"204", 204, true, "ответ без тела"},
		// Панель на Next.js уводит с корня на логин кодом 307. Приложение при
		// этом совершенно живо, и красить его красным значит поднимать ложную
		// тревогу. Поймано на проде, а не придумано.
		{"307", 307, true, "перенаправление это ответ живого приложения"},
		{"404", 404, false, "адрес указан не тот, человеку надо это знать"},
		{"503", 503, false, "приложение отвечает, но лежит"},
		// curl печатает 000, когда ответа не было вовсе.
		{"000", 0, false, "ответа не было"},
	}
	for _, tc := range cases {
		t.Run(tc.out, func(t *testing.T) {
			c := &recordingConn{res: transport.Result{Stdout: tc.out}}
			got, err := healthService(t, c).Check("srv1", "http://127.0.0.1:8081/health")
			if err != nil {
				t.Fatal(err)
			}
			if got.Code != tc.code || got.OK != tc.ok {
				t.Fatalf("%s: получено код=%d ok=%v, ожидалось код=%d ok=%v",
					tc.why, got.Code, got.OK, tc.code, tc.ok)
			}
		})
	}
}

func TestHealthKeepsLastSuccessAcrossFailures(t *testing.T) {
	c := &recordingConn{res: transport.Result{Stdout: "200"}}
	h := healthService(t, c)

	first, err := h.Check("srv1", "http://a/health")
	if err != nil {
		t.Fatal(err)
	}
	if first.LastOkAt == 0 {
		t.Fatal("успешная проверка не запомнила время")
	}

	// Теперь сервис лёг. Время последнего УСПЕШНОГО ответа обязано пережить
	// неудачу: «проверено 5 секунд назад» у лежащего сервиса бесполезно, а
	// «последний раз отвечал в 14:32» говорит всё.
	c.res = transport.Result{Stdout: "000"}
	time.Sleep(10 * time.Millisecond)
	second, err := h.Check("srv1", "http://a/health")
	if err != nil {
		t.Fatal(err)
	}
	if second.OK {
		t.Fatal("код 000 это отсутствие ответа, а не здоровье")
	}
	if second.LastOkAt != first.LastOkAt {
		t.Fatalf("время последнего успеха затёрлось: было %d, стало %d",
			first.LastOkAt, second.LastOkAt)
	}
	if second.CheckedAt <= first.CheckedAt {
		t.Fatal("время самой проверки обязано двигаться")
	}
}

func TestHealthSeparatesServersAndURLs(t *testing.T) {
	c := &recordingConn{res: transport.Result{Stdout: "200"}}
	reg := NewConnRegistry()
	reg.Set("srv1", c)
	reg.Set("srv2", c)
	h := NewHealthService(reg)

	if _, err := h.Check("srv1", "http://a/health"); err != nil {
		t.Fatal(err)
	}
	// Другой адрес на том же сервере это другая проверка: успех одного не
	// должен рисовать здоровье второму.
	other, err := h.Check("srv1", "http://b/health")
	if err != nil {
		t.Fatal(err)
	}
	c.res = transport.Result{Stdout: "500"}
	third, err := h.Check("srv2", "http://a/health")
	if err != nil {
		t.Fatal(err)
	}
	if other.LastOkAt == 0 {
		t.Fatal("вторая проверка обязана иметь своё время успеха")
	}
	if third.LastOkAt != 0 {
		t.Fatal("успех на другом сервере засчитан этому")
	}
}

func TestHealthWithoutURLIsNotAnError(t *testing.T) {
	c := &recordingConn{res: transport.Result{Stdout: "200"}}
	h := healthService(t, c)

	// Пустой адрес значит «проверки нет». Это не ошибка и не повод дёргать
	// сервер: у большинства проектов health-check не настроен вовсе.
	got, err := h.Check("srv1", "")
	if err != nil {
		t.Fatalf("пустой адрес считается ошибкой: %v", err)
	}
	if got.Configured {
		t.Fatal("проверка без адреса числится настроенной")
	}
	if len(c.cmds) != 0 {
		t.Fatalf("на сервер ушла команда без адреса: %v", c.cmds)
	}
}
