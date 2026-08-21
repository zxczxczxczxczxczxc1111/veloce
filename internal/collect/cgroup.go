package collect

import (
	"fmt"
	"strconv"
	"strings"
)

// Читается только cgroup v2. На v1 (ядра старше 5.x) каталоги разложены иначе,
// и тащить оба поколения ради очень старых серверов мы не будем: там
// показывается только статус. Наличие v2 определяется по файлу
// /sys/fs/cgroup/cgroup.controllers.
type CgroupCPU struct {
	UsageUsec uint64
}

func ParseCgroupCPUStat(out string) (CgroupCPU, error) {
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[0] == "usage_usec" {
			v, err := strconv.ParseUint(f[1], 10, 64)
			if err != nil {
				return CgroupCPU{}, err
			}
			return CgroupCPU{UsageUsec: v}, nil
		}
	}
	return CgroupCPU{}, fmt.Errorf("usage_usec не найден")
}

func ParseCgroupMemory(out string) (uint64, error) {
	return strconv.ParseUint(strings.TrimSpace(out), 10, 64)
}

// CgroupCPUPercent переводит прирост процессорного времени в проценты одного
// ядра. Значение выше 100 законно: процесс мог занять несколько ядер.
func CgroupCPUPercent(prevUsec, curUsec uint64, seconds float64) float64 {
	if seconds <= 0 || curUsec < prevUsec {
		return 0
	}
	delta := float64(curUsec-prevUsec) / 1_000_000 // в секунды
	return delta / seconds * 100
}
