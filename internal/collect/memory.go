package collect

import (
	"fmt"
	"strconv"
	"strings"
)

type Memory struct {
	TotalBytes uint64
	UsedBytes  uint64
}

func ParseMeminfo(out string) (Memory, error) {
	vals := map[string]uint64{}
	for _, line := range strings.Split(out, "\n") {
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimSuffix(parts[0], ":")
		v, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			continue
		}
		vals[key] = v * 1024 // значения в килобайтах
	}

	total, ok := vals["MemTotal"]
	if !ok {
		return Memory{}, fmt.Errorf("MemTotal не найден")
	}

	// MemAvailable точнее, но на старых ядрах его нет: там приближаем суммой
	// свободного, буферов и кэша.
	avail, ok := vals["MemAvailable"]
	if !ok {
		avail = vals["MemFree"] + vals["Buffers"] + vals["Cached"]
	}
	if avail > total {
		avail = total
	}
	return Memory{TotalBytes: total, UsedBytes: total - avail}, nil
}
