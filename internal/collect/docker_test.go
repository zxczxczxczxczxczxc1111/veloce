package collect

import "testing"

// ВАЖНО: `docker ps --format json` отдаёт по объекту НА СТРОКУ, а не массив.
// Скормить это json.Unmarshal целиком нельзя, будет ошибка разбора.
const dockerPSFixture = `{"ID":"a1b2c3","Names":"demo-app","Image":"demo-app-app","State":"running","Status":"Up 3 days"}
{"ID":"d4e5f6","Names":"demo-worker","Image":"demo-worker","State":"exited","Status":"Exited (0) 2 hours ago"}
`

func TestParseDockerPS(t *testing.T) {
	got, err := ParseDockerPS(dockerPSFixture)
	if err != nil {
		t.Fatalf("ParseDockerPS: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("получено %d записей", len(got))
	}
	if got[0].Name != "demo-app" || got[0].State != "running" {
		t.Fatalf("первая запись %+v", got[0])
	}
	if got[1].State != "exited" {
		t.Fatalf("вторая запись %+v", got[1])
	}
}

func TestParseDockerPSEmpty(t *testing.T) {
	// Пустой вывод это «контейнеров нет», а не ошибка.
	got, err := ParseDockerPS("\n")
	if err != nil {
		t.Fatalf("пустой вывод не должен быть ошибкой: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("ожидался пустой список, получено %d", len(got))
	}
}

const dockerStatsFixture = `{"Name":"demo-app","CPUPerc":"12.34%","MemUsage":"512.3MiB / 7.66GiB"}
{"Name":"demo-worker","CPUPerc":"0.00%","MemUsage":"128MiB / 7.66GiB"}
`

func TestParseDockerStats(t *testing.T) {
	got, err := ParseDockerStats(dockerStatsFixture)
	if err != nil {
		t.Fatalf("ParseDockerStats: %v", err)
	}
	if got[0].CPUPercent != 12.34 {
		t.Fatalf("CPU %v", got[0].CPUPercent)
	}
	// 512.3 MiB. Считаем через float64-переменную, а не константным
	// выражением: uint64(512.3 * 1024 * 1024) это нецелая нетипизированная
	// константа, и Go отказывается её усекать прямо на компиляции
	// («constant 537185484.8 truncated to integer»).
	mib := 512.3 * float64(1024*1024)
	if want := uint64(mib); got[0].MemBytes != want {
		t.Fatalf("память %d, ожидалось %d", got[0].MemBytes, want)
	}
}
