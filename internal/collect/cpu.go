package collect

import (
	"fmt"
	"strconv"
	"strings"
)

// CPUSample - сырые счётчики из /proc/stat. Абсолютные значения бессмысленны,
// работает только разница между двумя замерами.
type CPUSample struct {
	Total uint64
	Idle  uint64
}

func ParseStat(out string) (CPUSample, error) {
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)[1:]
		if len(fields) < 5 {
			return CPUSample{}, fmt.Errorf("в строке cpu меньше пяти полей: %q", line)
		}
		var s CPUSample
		for i, f := range fields {
			v, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				return CPUSample{}, fmt.Errorf("поле %d: %w", i, err)
			}
			s.Total += v
			// idle это поле 3, iowait это поле 4 (нумерация с нуля).
			if i == 3 || i == 4 {
				s.Idle += v
			}
		}
		return s, nil
	}
	return CPUSample{}, fmt.Errorf("строка cpu не найдена")
}

// CPUPercent считает загрузку между двумя замерами. Возвращает 0 при любой
// бессмыслице: нулевой такт, перезагрузка сервера, обнуление счётчиков. Ноль
// честнее, чем отрицательное число или деление на ноль.
func CPUPercent(prev, cur CPUSample) float64 {
	if cur.Total <= prev.Total || cur.Idle < prev.Idle {
		return 0
	}
	dTotal := float64(cur.Total - prev.Total)
	dIdle := float64(cur.Idle - prev.Idle)
	if dTotal == 0 {
		return 0
	}
	p := (dTotal - dIdle) / dTotal * 100
	if p < 0 {
		return 0
	}
	if p > 100 {
		return 100
	}
	return p
}
