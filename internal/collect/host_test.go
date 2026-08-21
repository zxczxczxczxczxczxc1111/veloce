package collect

import (
	"context"
	"io"
	"strings"
	"testing"

	"github.com/zxczxczxczxczxczxc1111/veloce/internal/transport"
)

// fakeConn отдаёт заранее заготовленный вывод. Настоящий SSH здесь не нужен:
// проверяется склейка кусков и деградация, а не транспорт.
type fakeConn struct {
	outputs []string
	calls   int
}

func (f *fakeConn) Run(context.Context, string) (transport.Result, error) {
	out := f.outputs[min(f.calls, len(f.outputs)-1)]
	f.calls++
	return transport.Result{Stdout: out}, nil
}

func (f *fakeConn) Stream(context.Context, string) (io.ReadCloser, error) { return nil, nil }
func (f *fakeConn) State() transport.State                               { return transport.StateConnected }
func (f *fakeConn) SetStateHook(func(transport.State))                   {}
func (f *fakeConn) Close() error                                         { return nil }

func joinParts(parts ...string) string { return strings.Join(parts, sep) }

func fullOutput(stat string) string {
	return joinParts(stat, meminfoFixture, dfFixture, netdevFixture, "350735.47 234388.90\n")
}

func TestCollectFirstSnapshotIsNotValid(t *testing.T) {
	c := &fakeConn{outputs: []string{fullOutput(statFixture)}}
	h := NewHostCollector()

	snap, err := h.Collect(context.Background(), c)
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	// Первый снимок не с чем сравнивать, дельты нет.
	if snap.Valid {
		t.Fatal("первый снимок помечен валидным, дельту считать не с чего")
	}
	if len(snap.Missing) != 0 {
		t.Fatalf("на полном выводе ничего не должно теряться, потеряно %v", snap.Missing)
	}
	if snap.Mem.TotalBytes == 0 || len(snap.Disks) != 2 {
		t.Fatalf("снимок разобран неполно: %+v", snap)
	}
}

func TestCollectSecondSnapshotHasDelta(t *testing.T) {
	// Второй /proc/stat: добавилось 200 тиков, из них 100 простоя.
	const statLater = `cpu  259912 1204 74329 8912445 5521 0 3311 0 0 0
`
	c := &fakeConn{outputs: []string{fullOutput(statFixture), fullOutput(statLater)}}
	h := NewHostCollector()

	if _, err := h.Collect(context.Background(), c); err != nil {
		t.Fatalf("первый Collect: %v", err)
	}
	snap, err := h.Collect(context.Background(), c)
	if err != nil {
		t.Fatalf("второй Collect: %v", err)
	}
	if !snap.Valid {
		t.Fatal("второй снимок обязан быть валидным")
	}
	if snap.CPUPercent != 50 {
		t.Fatalf("загрузка %v, ожидалось 50", snap.CPUPercent)
	}
}

func TestCollectDegradesPerPart(t *testing.T) {
	// Сеть не прочиталась, остальное на месте. Снимок обязан выжить.
	out := joinParts(statFixture, meminfoFixture, dfFixture, "мусор", "350735.47 0\n")
	c := &fakeConn{outputs: []string{out}}

	snap, err := NewHostCollector().Collect(context.Background(), c)
	if err != nil {
		t.Fatalf("один нечитаемый кусок не должен ронять весь снимок: %v", err)
	}
	if len(snap.Missing) != 1 || snap.Missing[0] != "net" {
		t.Fatalf("Missing = %v, ожидалось ровно [net]", snap.Missing)
	}
	if snap.Mem.TotalBytes == 0 {
		t.Fatal("память потерялась вместе с сетью")
	}
}

func TestCollectFailsWhenNothingParsed(t *testing.T) {
	// Пустой ответ это не деградация, а обрыв: наверх обязана уйти ошибка.
	c := &fakeConn{outputs: []string{""}}
	if _, err := NewHostCollector().Collect(context.Background(), c); err == nil {
		t.Fatal("пустой вывод принят за нормальный снимок")
	}
}
