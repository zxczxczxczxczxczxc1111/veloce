package collect

import "testing"

// Первая строка /proc/stat: user nice system idle iowait irq softirq steal.
const statFixture = `cpu  259812 1204 74329 8912345 5521 0 3311 0 0 0
cpu0 129906 602 37164 4456172 2760 0 1655 0 0 0
intr 123456789
ctxt 987654321
`

func TestParseStat(t *testing.T) {
	got, err := ParseStat(statFixture)
	if err != nil {
		t.Fatalf("ParseStat: %v", err)
	}
	// Total это сумма всех полей, Idle это idle плюс iowait.
	wantTotal := uint64(259812 + 1204 + 74329 + 8912345 + 5521 + 0 + 3311 + 0 + 0 + 0)
	wantIdle := uint64(8912345 + 5521)
	if got.Total != wantTotal || got.Idle != wantIdle {
		t.Fatalf("получено %+v, ожидалось Total=%d Idle=%d", got, wantTotal, wantIdle)
	}
}

func TestCPUPercentUsesDelta(t *testing.T) {
	prev := CPUSample{Total: 1000, Idle: 800}
	cur := CPUSample{Total: 1100, Idle: 850}
	// За такт добавилось 100 тиков, из них 50 простоя, значит загрузка 50%.
	if got := CPUPercent(prev, cur); got != 50 {
		t.Fatalf("получено %v, ожидалось 50", got)
	}
}

func TestCPUPercentSurvivesCounterReset(t *testing.T) {
	// Сервер перезагрузился, счётчики обнулились. Отдать отрицательную загрузку
	// или поделить на ноль нельзя.
	prev := CPUSample{Total: 5000, Idle: 4000}
	cur := CPUSample{Total: 10, Idle: 8}
	if got := CPUPercent(prev, cur); got != 0 {
		t.Fatalf("получено %v, ожидалось 0", got)
	}
}
