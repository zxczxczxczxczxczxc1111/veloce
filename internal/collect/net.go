package collect

import (
	"fmt"
	"strconv"
	"strings"
)

type NetSample struct {
	RxBytes uint64
	TxBytes uint64
}

// ParseNetDev складывает трафик всех интерфейсов кроме lo и docker-мостов:
// внутренний трафик контейнеров не относится к нагрузке на внешний канал.
func ParseNetDev(out string) (NetSample, error) {
	var s NetSample
	found := 0
	for _, line := range strings.Split(out, "\n") {
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		name := strings.TrimSpace(line[:idx])
		if name == "lo" || strings.HasPrefix(name, "docker") ||
			strings.HasPrefix(name, "br-") || strings.HasPrefix(name, "veth") {
			continue
		}
		f := strings.Fields(line[idx+1:])
		if len(f) < 9 {
			continue
		}
		rx, err1 := strconv.ParseUint(f[0], 10, 64)
		tx, err2 := strconv.ParseUint(f[8], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		s.RxBytes += rx
		s.TxBytes += tx
		found++
	}
	// Ни одного интерфейса значит /proc/net/dev не прочитался или пуст. Без
	// этой проверки функция не возвращала ошибку НИКОГДА, поле "net" не
	// попадало в Missing, и фронт получал rxPerSec: 0 вместо прочерка. Ноль
	// читается как «трафика нет», а это противоположность правде.
	if found == 0 {
		return NetSample{}, fmt.Errorf("в /proc/net/dev нет ни одного пригодного интерфейса")
	}
	return s, nil
}

func NetRate(prev, cur NetSample, seconds float64) (float64, float64) {
	if seconds <= 0 || cur.RxBytes < prev.RxBytes || cur.TxBytes < prev.TxBytes {
		return 0, 0
	}
	return float64(cur.RxBytes-prev.RxBytes) / seconds,
		float64(cur.TxBytes-prev.TxBytes) / seconds
}
